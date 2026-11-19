import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import { type QueueInfo, queueText } from "../state/queue";
import { useQuery } from "../state/store";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { UsageDashboard } from "./usage/UsageDashboard";
import { usageRange, number, type Period } from "./usage/dashboardModel";
import { dashboardStyles } from "./usage/dashboard.stylex";
import { SidebarUsage, useAccountUsage } from "./sidebar/SidebarUsage";
import { TextInput } from "../design/Fields";
import { usePrefs } from "../state/device";
import { absoluteTime } from "../state/time";
import { usePaneVisible } from "../state/paneVisibility";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Icon } from "./icons";

type CapacityRequest = { turn_id: string; status: string; session_id: string; session_title: string; project_id: string; queue?: QueueInfo };
type Capacity = {
    limits: { max_active: number | null; max_queued_per_owner: number | null; max_queued_total: number | null };
    server: { running: number; waiting: number };
    mine: { running: number; waiting: number; awaiting_user: number };
    requests: CapacityRequest[];
};

/// 실행 용량(FAIR-011): 서버 전체는 합계·한도만, 대기 이유와 취소는 이 기기의 요청에만 보여 준다.
function CapacitySection() {
    const q = useQuery<Capacity>("usage-capacity", () => api.get("/usage/capacity"));
    const [err, setErr] = useState<string | null>(null);
    const c = q.data;
    if (!c) return null;
    const cancel = async (id: string) => {
        setErr(null);
        try {
            await api.post(`/turns/${id}/cancel`);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "취소 실패");
        }
        q.reload();
    };
    const limit = (n: number | null) => (n == null ? "제한 없음" : String(n));
    return (
        <GroveStack gap={0} data-testid="usage-capacity">
            <GroveHeading level={3} color="inherit">실행 용량</GroveHeading>
            <GroveText as="p" display="block" type="inherit" color="inherit">
                서버 전체: 실행 {c.server.running}/{limit(c.limits.max_active)} · 대기 {c.server.waiting}
                <GroveText type="supporting" color="secondary"> · 기기별 대기 한도 {limit(c.limits.max_queued_per_owner)} · 서버 대기 한도 {limit(c.limits.max_queued_total)}</GroveText>
            </GroveText>
            {c.requests.length === 0 ? (
                <GroveText as="p" display="block" type="inherit" color="secondary">이 기기에서 실행·대기 중인 요청이 없습니다.</GroveText>
            ) : (
                <GroveList density="compact" edge="flush" hasDividers>
                    {c.requests.map((r) => (
                        <GroveListItem key={r.turn_id} data-testid="capacity-request" label={<>
                            <GroveText type="inherit" color="inherit">{r.session_title || "제목 없는 대화"}</GroveText>{" "}
                            <GroveText type="supporting" color="secondary">
                                {r.queue ? queueText(r.queue) : r.status === "awaiting_approval" ? "승인·답변 대기(실행 슬롯 사용 안 함)" : r.status === "queued" ? "대기 중" : "실행 중"}
                            </GroveText>{" "}
                            <ServerActionButton variant="secondary" density="compact" onClick={() => void cancel(r.turn_id)}>취소</ServerActionButton>
                        </>} />
                    ))}
                </GroveList>
            )}
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
        </GroveStack>
    );
}

const PERIODS = [
    { value: "1h", label: "지난 1시간" }, { value: "8h", label: "지난 8시간" },
    { value: "24h", label: "지난 24시간" }, { value: "7d", label: "지난 7일" },
    { value: "30d", label: "지난 30일" }, { value: "custom", label: "사용자 지정" },
];

export function UsagePanel({ onClose, onAuthenticate }: { onClose: () => void; onAuthenticate: (protocol: string) => void }) {
    const active = usePaneVisible();
    const [period, setPeriod] = useState<Period>("24h");
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const heading = useRef<HTMLHeadingElement>(null);
    const prefs = usePrefs();
    const valid = usageRange(period, start, end);
    const identity = JSON.stringify([period, start, end, new Date().getTimezoneOffset()]);
    const q = useQuery(valid ? `usage:dashboard:${identity}` : null, () => {
        const range = usageRange(period, start, end)!;
        return api.getContract("UsageDashboard", `/usage/dashboard?${new URLSearchParams(range)}`);
    }, { keepPreviousData: true, scope: "usage:dashboard" });
    // 계정 한도는 통계와 독립적이므로 통계 응답 뒤가 아니라 화면 진입 시 함께 조회한다.
    useAccountUsage();
    const reload = useRef(q.reload);
    reload.current = q.reload;
    useEffect(() => {
        if (!active) return;
        const focus = () => heading.current?.focus({ preventScroll: true });
        const drawer = document.querySelector<HTMLDialogElement>('dialog[data-mobile-drawer][open]');
        if (!drawer) { focus(); return; }
        drawer.addEventListener("close", focus, { once: true });
        return () => drawer.removeEventListener("close", focus);
    }, [active]);
    useEffect(() => {
        if (!active) return;
        const refresh = () => { if (document.visibilityState === "visible") reload.current(); };
        const timer = setInterval(refresh, 120_000);
        document.addEventListener("visibilitychange", refresh);
        return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
    }, [active]);
    const report = q.data;
    return <GroveStack as="section" gap={0} data-testid="usage-panel" aria-label="사용량">
        <GroveStack xstyle={dashboardStyles.content}>
            <GroveStack as="header" direction="horizontal" align="center" justify="between" gap={2}>
                <GroveStack direction="horizontal" align="center" gap={2}>
                    <GroveHeading level={2} ref={heading} tabIndex={-1} xstyle={dashboardStyles.page}>사용량</GroveHeading>
                    <GroveText type="supporting" color="secondary">서버 전체</GroveText>
                </GroveStack>
                <GroveButton type="button" appearance="icon" aria-label="사용량 닫기" onClick={onClose}><Icon name="close" size={16} /></GroveButton>
            </GroveStack>
            <GroveStack gap={2}>
                <GroveStack direction="horizontal" align="center" wrap="wrap" justify="between" gap={2}>
                    <GroveStack direction="horizontal" wrap="wrap" xstyle={dashboardStyles.periods} role="group" aria-label="기간">
                        {PERIODS.map((item) => <GroveButton key={item.value} type="button" appearance="choice" aria-pressed={period === item.value}
                            xstyle={[dashboardStyles.period, period === item.value && dashboardStyles.periodSelected]} onClick={() => setPeriod(item.value as Period)}>{item.label}</GroveButton>)}
                    </GroveStack>
                    <GroveButton type="button" variant="secondary" xstyle={dashboardStyles.refresh} aria-label="사용량 새로고침" disabled={!valid || q.loading} onClick={q.reload}>{q.loading ? "조회 중…" : q.error ? "다시 시도" : "↻ 새로고침"}</GroveButton>
                </GroveStack>
                {period === "custom" && <GroveStack direction="horizontal" gap={2} wrap="wrap">
                    <GroveStack xstyle={dashboardStyles.date}><TextInput type="date" label="시작일" value={start} onChange={setStart} /></GroveStack>
                    <GroveStack xstyle={dashboardStyles.date}><TextInput type="date" label="종료일" value={end} onChange={setEnd} /></GroveStack>
                </GroveStack>}
                {!valid && <GroveText type="supporting" color="secondary">시작일과 종료일을 선택해 주세요. 최대 400일까지 볼 수 있어요.</GroveText>}
                {report && <GroveText xstyle={dashboardStyles.small} color="secondary">{absoluteTime(report.from, prefs)} ~ {absoluteTime(report.to, prefs)} · 2분마다 자동 갱신</GroveText>}
            </GroveStack>
            {valid && !report && !q.error && <GroveText role="status" color="secondary">사용량 불러오는 중…</GroveText>}
            {q.error != null && <GroveText role="alert" color="error">사용량을 불러오지 못했어요.{report ? " 마지막 조회값을 표시해요." : ""}</GroveText>}
            {report && <GroveStack xstyle={dashboardStyles.flow} aria-busy={q.loading}>
                <UsageDashboard report={report} quotas={<GroveStack as="section" aria-label="OAuth 한도" xstyle={dashboardStyles.flow}>
                    <GroveHeading level={2} xstyle={dashboardStyles.sectionTitle}>OAuth 한도</GroveHeading>
                    <SidebarUsage onAuthenticate={onAuthenticate} showEmpty presentation="cards" />
                </GroveStack>} />
                <Collapsible trigger="실행 현황·추정 비용" defaultIsOpen={false}>
                    <GroveStack gap={4} paddingBlock={3}>
                        <CapacitySection />
                        <GroveText type="supporting" color="secondary">추정 비용 {report.estimated_cost.length
                            ? report.estimated_cost.map((cost) => `${cost.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cost.currency}`).join(" · ")
                            : "가격 정보 없음"}{report.unpriced_tokens > 0 ? ` · 가격 미설정 ${number(report.unpriced_tokens)} 토큰` : ""}</GroveText>
                        <GroveText type="supporting" color="secondary">현재 가격표{report.pricing_versions.length ? `(${report.pricing_versions.join(", ")})` : ""} 기준 추정치이며 계정 청구액과 다를 수 있어요.</GroveText>
                    </GroveStack>
                </Collapsible>
            </GroveStack>}
        </GroveStack>
    </GroveStack>;
}
