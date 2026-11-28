import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import * as stylex from "@stylexjs/stylex";
import { lazy, Suspense } from "react";
import { api } from "../../api/client";
import type { ModelProfile, SecretInfo } from "../../api/generated";
import { useCapability } from "../../state/capabilities";
import { ServerActionButton } from "../pwa/ServerActionButton";
import { ActionMenu, DetailDialog } from "../ui/Controls";
import { When } from "../When";
import { useProfileCatalog } from "../ProfileCatalog";
import { ProfileCapabilities } from "../ProfileCapabilities";
import { ProfileContextPolicy } from "../ProfileContextPolicy";
import { fallbackOptions, ProfileFallback } from "../ProfileFallback";
import { ProviderMark } from "../usage/ProviderMark";

const AgentAccount = lazy(async () => ({ default: (await import("../AgentLogin")).AgentAccount }));

const ACCOUNT_PROTOCOLS = new Set(["claude_code", "codex_cli", "codex_oauth"]);
const CLI_PROTOCOLS = new Set(["claude_code", "codex_cli"]);
const PROTOCOL_LABELS: Record<string, string> = {
    openai: "OpenAI 호환", anthropic: "Anthropic", gemini: "Gemini",
    claude_code: "서버 CLI", codex_cli: "서버 CLI", codex_oauth: "Codex 계정",
};

const styles = stylex.create({
    dot: { width: 8, height: 8, flexShrink: 0, borderRadius: "var(--radius-full)", backgroundColor: "var(--line-strong)" },
    ok: { backgroundColor: "var(--ok)" },
    failed: { backgroundColor: "var(--err)" },
    name: { minWidth: 0 },
    body: { containerType: "inline-size", containerName: "profile" },
    // 카드마다 이름·모델·동작 열의 시작 위치가 같도록 고정 열을 쓰고, 좁으면 한 열로 쌓는다.
    heading: {
        display: "grid", alignItems: "center", columnGap: "var(--spacing-4)", rowGap: "var(--spacing-2)",
        gridTemplateColumns: { default: "200px 190px minmax(0, 1fr)", "@container profile (max-width: 560px)": "minmax(0, 1fr)" },
    },
    identity: { minWidth: 0 },
    // 한글 단어 중간에서 끊지 않되, 긴 URL·버전은 칸 안에서 줄바꿈한다.
    summary: { wordBreak: "keep-all", overflowWrap: "anywhere" },
    actions: { justifySelf: { default: "end", "@container profile (max-width: 560px)": "start" }, flexWrap: "wrap" },
});

type Check = ModelProfile["last_check"];
const detail = (c: NonNullable<Check>) => (c.detail ?? {}) as { models?: number; model_listed?: boolean; cli_version?: string };
const version = (value: string) => value.match(/\d+(?:\.\d+)+/)?.[0] ?? value;

/// 행의 짧은 연결 상태. 시각은 상세 설정에서 확인한다.
function CheckSummary({ c }: { c: Check }) {
    if (!c) return <Text as="span" type="inherit" color="inherit" data-testid="profile-check">연결 확인 안 함</Text>;
    const d = detail(c);
    return <Text as="span" type="inherit" color="inherit" data-testid="profile-check">
        {d.cli_version !== undefined ? "설치됨" : "연결됨"} {c.latency_ms}ms
        {d.cli_version && ` · ${version(d.cli_version)}`}
        {d.models !== undefined && (d.model_listed ? " · 모델 확인됨" : ` · 목록(${d.models}개)에 이 모델 없음`)}
    </Text>;
}

function CheckFailure({ c }: { c: NonNullable<Check> }) {
    return <Text as="p" display="block" type="supporting" color="error" data-testid="profile-check">
        연결 실패 <code>{c.code}</code> {c.message} · <When at={c.checked_at} />
    </Text>;
}

function CheckDetail({ profile: p }: { profile: ModelProfile }) {
    const c = p.last_check;
    return <Text as="p" display="block" type="supporting" color="secondary" wordBreak="break-word">
        {p.protocol === "codex_cli" ? "Codex CLI" : p.protocol}
        {p.base_url ? ` · ${p.base_url}` : CLI_PROTOCOLS.has(p.protocol) ? " · 서버 CLI · 프로젝트 수정·검사 가능" : ""}
        {c ? <> · {c.ok ? `확인 ${c.latency_ms}ms` : "연결 실패"} · <When at={c.checked_at} />{detail(c).cli_version && ` · ${detail(c).cli_version}`}</> : " · 연결 확인 안 함"}
    </Text>;
}

type Run = (action: () => Promise<unknown>) => Promise<void>;

/// 모델 프로필은 한 줄로 상태·모델·계정만 보이고, 모델 기능·context·fallback은 상세 설정 대화상자에서 편집한다.
export function ProfileRow({ profile: p, profiles, secrets, run }: {
    profile: ModelProfile; profiles: ModelProfile[]; secrets: SecretInfo[]; run: Run;
}) {
    const management = useCapability("model_management_v1");
    const authSupported = useCapability("agent_auth_v1");
    const catalog = useProfileCatalog(p, (model, revision) => void run(() =>
        api.put(`/model-profiles/${p.id}`, { expected_revision: revision, model }, { requires: ["model_management_v1"] })));
    const secret = p.secret_id ? secrets.find((s) => s.id === p.secret_id) : undefined;
    const fallback = fallbackOptions(p);
    const failed = p.last_check?.ok === false;
    return <Card width="100%" padding={5} data-testid="model-profile">
        <Stack gap={2} xstyle={styles.body}>
            <div {...stylex.props(styles.heading)} data-testid="profile-heading">
                <Stack direction="horizontal" align="center" gap={2} xstyle={styles.identity}>
                    <span aria-hidden {...stylex.props(styles.dot, p.last_check?.ok === true && styles.ok, failed && styles.failed)} />
                    <Stack gap={0} xstyle={styles.name}>
                        <Text type="label" weight="semibold" wordBreak="break-word"><ProviderMark protocol={p.protocol} />{p.name}</Text>
                        <Text type="supporting" color="secondary" xstyle={styles.summary}>
                            {PROTOCOL_LABELS[p.protocol] ?? p.protocol}
                            {!failed && <> · <CheckSummary c={p.last_check} /></>}
                            {fallback.enabled && ` · fallback ${fallback.candidates.length}`}
                            {p.enabled === false && <Text as="span" type="inherit" color="warning"> · 비활성</Text>}
                        </Text>
                    </Stack>
                </Stack>
                {catalog.control ?? <span />}
                <Stack direction="horizontal" align="center" gap={1.5} xstyle={styles.actions}>
                    {authSupported && ACCOUNT_PROTOCOLS.has(p.protocol) && <Suspense fallback={null}>
                        <AgentAccount protocol={p.protocol} name={p.name} disabled={false} />
                    </Suspense>}
                    {secret && <ServerActionButton variant="secondary" density="compact" onClick={() => {
                        const value = prompt(`${secret.label}의 새 키(이전 키는 저장 성공 후에만 교체)`);
                        if (value) void run(() => api.put(`/secrets/${secret.id}`, { label: secret.label, value }));
                    }}>키 교체</ServerActionButton>}
                    <DetailDialog label={`${p.name} 상세 설정`} title={`${p.name} 상세 설정`} trigger="상세 설정" showExpand={false} appearance="plain">
                        <CheckDetail profile={p} />
                        <Stack gap={5} paddingBlockStart={2}>
                            <ProfileCapabilities profile={p} />
                            <ProfileContextPolicy profile={p} />
                            <ProfileFallback profile={p} profiles={profiles} />
                        </Stack>
                    </DetailDialog>
                    <ActionMenu label={`${p.name} 관리`}>
                        <ServerActionButton variant="secondary" density="compact" onClick={() => {
                            const m = prompt("모델 이름", p.model);
                            if (m && m !== p.model) void run(() => api.put(`/model-profiles/${p.id}`, { expected_revision: p.revision, model: m }));
                        }}>모델 변경</ServerActionButton>
                        <ServerActionButton variant="secondary" density="compact" onClick={() => void run(() => api.post(`/model-profiles/${p.id}/check`))}>연결 확인</ServerActionButton>
                        {management !== false && <ServerActionButton variant="secondary" density="compact" onClick={() => void run(() =>
                            api.put(`/model-profiles/${p.id}`, { expected_revision: p.revision, enabled: p.enabled === false }, { requires: ["model_management_v1"] })
                        )}>{p.enabled === false ? "활성화" : "비활성화"}</ServerActionButton>}
                        <ServerActionButton variant="secondary" density="compact" onClick={() => void run(() => api.del(`/model-profiles/${p.id}`))}>삭제</ServerActionButton>
                    </ActionMenu>
                </Stack>
            </div>
            {failed && <CheckFailure c={p.last_check!} />}
            {catalog.messages}
        </Stack>
    </Card>;
}
