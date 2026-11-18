import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { lazy, Suspense, useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { AgentBackendCatalog, ModelProfile } from "../api/generated";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useCapability } from "../state/capabilities";
import { LoadingBar } from "./LoadingScreen";
import { DetailDialog } from "./ui/Controls";
import { HintText } from "../design/HintText";
import { Icon } from "./icons";

const AgentLogin = lazy(async () => ({ default: (await import("./AgentLogin")).AgentLogin }));

/// 에이전트 연결만 준비한다. 대화 생성과 모델 호출은 사용자가 보내기를 눌러야 시작된다.
export function AgentConnect({ disabled, onConnected }: { disabled: boolean; onConnected: (profile: ModelProfile) => void }) {
    const supported = useCapability("agent_backends_v1");
    const authSupported = useCapability("agent_auth_v1");
    const [accountsOpen, setAccountsOpen] = useState(false);
    const catalog = useQuery<AgentBackendCatalog>(supported === false ? null : "agent-backends",
        () => api.getContract("AgentBackendCatalog", "/agent-backends", { requires: ["agent_backends_v1"] }));
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [connected, setConnected] = useState<string | null>(null);
    const attempt = useRef<{ protocol: string; key: string } | null>(null);
    const busy = useRef(false);
    const connect = async (protocol: string) => {
        if (busy.current || disabled) return;
        busy.current = true;
        setPending(protocol);
        setError(null);
        setConnected(null);
        if (attempt.current?.protocol !== protocol) attempt.current = { protocol, key: newKey() };
        try {
            const profile = await api.post<ModelProfile>(`/agent-backends/${protocol}/connect`, {}, { key: attempt.current.key, requires: ["agent_backends_v1"] });
            attempt.current = null;
            setConnected(profile.name);
            onConnected(profile);
        } catch (cause) {
            setError(cause instanceof ApiError && cause.status === 403
                ? "등록한 기기에서 에이전트를 연결해 주세요."
                : cause instanceof Error ? cause.message : "에이전트 연결 실패");
        } finally {
            busy.current = false;
            setPending(null);
        }
    };
    if (supported === false) return <GroveText as="p" display="block" type="supporting" color="warning" role="status">에이전트 연결에는 서버 업데이트가 필요합니다.</GroveText>;
    return <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1} role="group" aria-label="대화할 에이전트" data-testid="agent-connect">
            {catalog.data?.backends.map((backend) => (
                <ServerActionButton key={backend.protocol} variant="secondary" density="compact" disabled={disabled || pending !== null || !backend.installed}
                    onClick={() => void connect(backend.protocol)}>
                    {pending === backend.protocol ? "연결 중…" : backend.name}
                    {!backend.installed && <GroveText type="supporting" color="secondary"> · 설치 필요</GroveText>}
                </ServerActionButton>
            ))}
        {catalog.data && <HintText type="supporting" color="secondary"
            hint={catalog.data.backends.every((backend) => !backend.read_only)
                ? "Codex는 Grove의 도구 권한 설정을 따라요. Claude Code는 자체 도구를 사용해요. 중단해도 이미 바뀐 파일은 유지돼요."
                : "프로젝트 수정·검사를 사용하려면 서버 업데이트가 필요해요."}>
            {catalog.data.backends.every((backend) => !backend.read_only) ? "코딩 가능" : "서버 CLI"}
        </HintText>}
        {authSupported && <DetailDialog label="에이전트 계정 로그인" title="계정 로그인" trigger={<Icon name="user" size={16} />} appearance="icon" onOpenChange={setAccountsOpen}>
            {accountsOpen && <Suspense fallback={<LoadingBar label="계정 로그인 여는 중…" />}>
                {catalog.data?.backends.filter((backend) => backend.installed).map((backend) =>
                    <AgentLogin key={backend.protocol} protocol={backend.protocol} name={backend.name} disabled={disabled} />)}
            </Suspense>}
        </DetailDialog>}
        {!catalog.data && !catalog.error && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">에이전트 확인 중…</GroveText>}
        {!!catalog.error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">에이전트를 확인하지 못했어요. <GroveButton type="button" variant="secondary" density="compact" onClick={catalog.reload}>다시 확인</GroveButton></GroveText>}
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
        {connected && <GroveText as="p" display="block" type="supporting" color="inherit" role="status">{connected} 프로필 준비됨</GroveText>}
    </GroveStack>;
}
