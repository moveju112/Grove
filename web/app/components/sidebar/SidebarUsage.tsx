import { Grid } from "@astryxdesign/core/Grid";
import { Link } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { useEffect, useState } from "react";
import { api, isTransportError } from "../../api/client";
import type { AccountUsageReport } from "../../api/generated";
import { HintText } from "../../design/HintText";
import { Button } from "../../design/Button";
import { usePrefs } from "../../state/device";
import { absoluteTime } from "../../state/time";
import { revalidateQuery, useQuery } from "../../state/store";
import { usePageVisible, usePaneVisible } from "../../state/paneVisibility";
import { usageStyles } from "./usage.stylex";
import { dashboardStyles } from "../usage/dashboard.stylex";
import { providerName } from "../usage/dashboardModel";

const statuses: Record<string, string> = {
    unsupported: "한도 조회 미지원",
    authentication_required: "인증 필요",
    unavailable: "조회 실패",
    rate_limited: "조회 제한",
};

const accounts = [
    { protocol: "claude_code", name: "Claude" },
    { protocol: "codex_cli", name: "Codex" },
] as const;
const periods = ["5시간", "주간"] as const;

/** 연결된 Claude·Codex의 공용 5시간·주간 사용률만 두 줄 안에 표시한다. */
export function UsageSummary({ report, failed = false, now = Date.now(), onAuthenticate }: {
    report: AccountUsageReport; failed?: boolean; now?: number; onAuthenticate?: (protocol: string) => void;
}) {
    const prefs = usePrefs();
    const connected = accounts.flatMap(({ protocol, name }) => {
        const account = report.accounts.find((account) => account.protocol === protocol);
        // 공용 5시간·주간 한도가 하나도 없는 계정은 빈 줄로 남기지 않는다.
        return account && (account.status !== "available" || periods.some((period) => account.limits.some((limit) =>
            limit.label === period && limit.remaining_percent !== null))) ? [{ ...account, name }] : [];
    });
    if (connected.length === 0) return null;
    return <Stack as="section" gap={2} paddingBlock={2} paddingInline={2}
        aria-label="사용 한도" data-testid="sidebar-usage" xstyle={usageStyles.summary}>
        {failed && <GroveText type="inherit" color="warning">갱신 실패 · 이전 값</GroveText>}
        {connected.map((account) => <Stack key={account.protocol} gap={0} data-testid="account-usage">
            {account.status !== "available" ? <Stack direction="horizontal" justify="between" gap={2}>
                <GroveText type="inherit" color="secondary">{account.name}</GroveText>
                {account.status === "authentication_required" && onAuthenticate ? <Button type="button" appearance="link" density="compact"
                    aria-label={`${account.name} 인증 설정 열기`} aria-haspopup="dialog" xstyle={usageStyles.authAction}
                    onClick={() => onAuthenticate(account.protocol)}>
                    <GroveText type="inherit" color="warning">인증 필요</GroveText>
                </Button> : <GroveText type="inherit" color={account.status === "unsupported" ? "secondary" : "warning"}>
                    {statuses[account.status] ?? "조회 실패"}
                </GroveText>}
            </Stack> : <Grid columns={2} gap={2} xstyle={usageStyles.limits}>
                {periods.map((period) => {
                    const limit = account.limits.find((limit) => limit.label === period);
                    const remaining = limit?.remaining_percent ?? null;
                    const used = remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining));
                    const expired = limit?.resets_at != null && Date.parse(limit.resets_at) <= now;
                    // 다 쓰지 않은 한도를 100%로, 쓰기 시작한 한도를 0%로 반올림하지 않는다.
                    // 요금제에 없는 기간은 자리만 비워 다른 기간의 열을 유지한다.
                    if (used === null) return <Stack key={period} aria-hidden="true" />;
                    const value = expired ? "갱신 대기"
                        : used > 0 && used < 0.1 ? "<0.1%" : used > 99.9 && used < 100 ? ">99.9%"
                        : `${used.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
                    const label = `${account.name} ${period}`;
                    const reset = limit?.resets_at ? ` · 초기화 ${absoluteTime(limit.resets_at, prefs)}` : "";
                    return <Stack gap={0.5} key={period} data-testid="account-usage-limit">
                        <Stack direction="horizontal" justify="between" align="center" gap={1}>
                            <HintText type="inherit" color="secondary" hint={`${label} 사용${reset}`} xstyle={usageStyles.label}>{label}</HintText>
                            <HintText type="inherit" hasTabularNumbers hint={`조회 ${absoluteTime(account.checked_at, prefs)}${reset}`}
                                color={expired ? "secondary" : "primary"}
                                aria-label={`${label} 사용 ${value}${reset}`} xstyle={usageStyles.value}>
                                {value}
                            </HintText>
                        </Stack>
                        {!expired && <ProgressBar label={`${label} 사용`} isLabelHidden value={used} max={100} variant="accent" />}
                    </Stack>;
                })}
            </Grid>}
        </Stack>)}
    </Stack>;
}

/** 사용량 화면만 원본의 OAuth 카드로 표시하고, 탐색 영역은 기존 두 줄 요약을 유지한다. */
function UsageQuotaCards({ report, failed, now, onAuthenticate }: {
    report: AccountUsageReport; failed: boolean; now: number; onAuthenticate: (protocol: string) => void;
}) {
    const prefs = usePrefs();
    const connected = accounts.flatMap(({ protocol }) => report.accounts.filter((account) => account.protocol === protocol));
    return <Stack direction="horizontal" wrap="wrap" xstyle={dashboardStyles.quotaCards} aria-label="OAuth 한도">
        {failed && <GroveText color="warning" xstyle={dashboardStyles.small}>갱신 실패 · 이전 값</GroveText>}
        {connected.map((account) => <Stack key={account.protocol} xstyle={[dashboardStyles.card, dashboardStyles.quotaCard]}>
            <Stack direction="horizontal" justify="between" align="center" gap={2}>
                <GroveText xstyle={dashboardStyles.cardTitle}>{providerName(account.protocol)}</GroveText>
                <Stack direction="horizontal" align="center" xstyle={[dashboardStyles.status, account.status === "available" && dashboardStyles.connected]}>
                    <svg width={7} height={7} aria-hidden="true"><circle cx={3.5} cy={3.5} r={3.5} fill="currentColor" /></svg>
                    <GroveText type="inherit" color="inherit">{account.status === "available" ? "연결됨" : statuses[account.status] ?? "조회 실패"}</GroveText>
                </Stack>
            </Stack>
            {account.status === "available" ? account.limits.map((limit, index) => {
                const expired = limit.resets_at != null && Date.parse(limit.resets_at) <= now;
                const used = limit.remaining_percent === null || expired ? null : Math.max(0, Math.min(100, 100 - limit.remaining_percent));
                const tone = used !== null && used >= 90 ? "var(--err)" : used !== null && used >= 70 ? "var(--warn)" : "var(--accent)";
                const value = expired ? "갱신 대기" : used === null ? limit.remaining ?? "—"
                    : account.protocol === "codex_cli" ? `${Number(used.toFixed(1))}% 사용 · ${Number(limit.remaining_percent!.toFixed(1))}% 남음`
                    : `${Number(used.toFixed(1))}% 사용`;
                return <Stack key={index} xstyle={dashboardStyles.quotaWindow}>
                    <Stack direction="horizontal" justify="between" gap={2}>
                        <GroveText xstyle={dashboardStyles.small}>{limit.label}</GroveText>
                        <GroveText xstyle={[dashboardStyles.small, dashboardStyles.quotaValue(used === null ? "var(--muted)" : tone)]} weight="semibold">{value}</GroveText>
                    </Stack>
                    {used !== null && <svg height={6} width="100%" role="img" aria-label={`${providerName(account.protocol)} ${limit.label} 사용 ${used.toFixed(1)}%`}>
                        <rect width="100%" height={6} rx={3} fill="var(--raised)" /><rect width={`${used}%`} height={6} rx={3} fill={tone} />
                    </svg>}
                    {limit.resets_at && <GroveText color="secondary" xstyle={dashboardStyles.hint}>초기화 {absoluteTime(limit.resets_at, prefs)}</GroveText>}
                </Stack>;
            }) : account.status === "authentication_required" && <Button type="button" appearance="link" xstyle={usageStyles.authAction} aria-label={`${providerName(account.protocol)} 인증 설정 열기`} onClick={() => onAuthenticate(account.protocol)}>인증 설정 열기</Button>}
            {account.limits.length === 0 && account.protocol !== "claude_code" && <GroveText color="secondary" xstyle={dashboardStyles.small}>현재 사용량 결과 없음</GroveText>}
            <Stack xstyle={dashboardStyles.quotaFooter}>
                {account.protocol === "claude_code" && account.status !== "authentication_required"
                    && (failed || account.status !== "available" || periods.some((period) => !account.limits.some((limit) =>
                        limit.label === period && limit.remaining_percent !== null && (!limit.resets_at || Date.parse(limit.resets_at) > now))))
                    && <Link type="inherit" href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">Claude에서 확인</Link>}
                <GroveText color="secondary" xstyle={dashboardStyles.hint}>마지막 조회 {absoluteTime(account.checked_at, prefs)}</GroveText>
            </Stack>
        </Stack>)}
        {connected.length === 0 && <GroveText xstyle={dashboardStyles.small} color="secondary">연결된 OAuth 계정 없음</GroveText>}
    </Stack>;
}

/** 첫 조회 전에도 카드 높이를 미리 잡아 한도가 도착할 때 아래 통계가 밀리지 않게 한다. */
function UsageQuotaPlaceholder() {
    return <Stack direction="horizontal" wrap="wrap" xstyle={dashboardStyles.quotaCards} aria-label="OAuth 한도" aria-busy="true">
        {accounts.map(({ protocol }) => <Stack key={protocol} xstyle={[dashboardStyles.card, dashboardStyles.quotaCard]}>
            <Stack direction="horizontal" justify="between" align="center" gap={2}>
                <GroveText xstyle={dashboardStyles.cardTitle}>{providerName(protocol)}</GroveText>
                <Stack direction="horizontal" align="center" xstyle={dashboardStyles.status}>
                    <svg width={7} height={7} aria-hidden="true"><circle cx={3.5} cy={3.5} r={3.5} fill="currentColor" /></svg>
                    <GroveText type="inherit" color="inherit">조회 중</GroveText>
                </Stack>
            </Stack>
            {periods.map((period) => <Stack key={period} xstyle={dashboardStyles.quotaWindow} aria-hidden="true">
                <Stack direction="horizontal" justify="between" gap={2}>
                    <GroveText xstyle={dashboardStyles.small}>{period}</GroveText>
                    <GroveText xstyle={[dashboardStyles.small, dashboardStyles.quotaValue("var(--muted)")]} weight="semibold">—</GroveText>
                </Stack>
                <svg height={6} width="100%"><rect width="100%" height={6} rx={3} fill="var(--raised)" /></svg>
                <GroveText color="secondary" xstyle={dashboardStyles.hint}>{"\u00a0"}</GroveText>
            </Stack>)}
            <Stack xstyle={dashboardStyles.quotaFooter}>
                <GroveText color="secondary" xstyle={dashboardStyles.hint}>마지막 조회 —</GroveText>
            </Stack>
        </Stack>)}
    </Stack>;
}

const accountUsageKey = "usage:accounts";
const refreshInterval = 60_000;

export function useAccountUsage() {
    return useQuery(accountUsageKey, () => api.getContract("AccountUsageReport", "/usage/accounts"));
}

export function SidebarUsage({ onAuthenticate, showEmpty = false, presentation = "summary" }: { onAuthenticate: (protocol: string) => void; showEmpty?: boolean; presentation?: "summary" | "cards" }) {
    const paneVisible = usePaneVisible();
    const pageVisible = usePageVisible();
    const active = paneVisible && pageVisible;
    const usage = useAccountUsage();
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!active) return;
        const refresh = () => { setNow(Date.now()); revalidateQuery(accountUsageKey, refreshInterval); };
        refresh();
        const timer = setInterval(refresh, refreshInterval);
        return () => clearInterval(timer);
    }, [active]);
    const failed = usage.error !== null && !isTransportError(usage.error);
    if (usage.data && presentation === "cards") return <UsageQuotaCards report={usage.data} failed={failed} now={now} onAuthenticate={onAuthenticate} />;
    if (usage.data) return showEmpty && !usage.data.accounts.some((account) => accounts.some(({ protocol }) => account.protocol === protocol))
        ? <GroveText type="supporting" color="secondary">연결된 CLI 계정이 없어요.</GroveText>
        : <UsageSummary report={usage.data} failed={failed} now={now} onAuthenticate={onAuthenticate} />;
    if (!failed) return presentation === "cards" ? <UsageQuotaPlaceholder /> : null;
    return <Stack as="section" padding={2} aria-label="사용 한도" data-testid="sidebar-usage">
        <GroveText type="supporting" color="warning">사용량 조회 실패</GroveText>
    </Stack>;
}
