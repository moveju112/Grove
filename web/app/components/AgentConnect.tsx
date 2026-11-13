import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { AgentBackendCatalog, ModelProfile } from "../api/generated";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useCapability } from "../state/capabilities";
import { AgentLogin } from "./AgentLogin";

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
                ? "소유자 기기에서 에이전트를 연결해 주세요."
                : cause instanceof Error ? cause.message : "에이전트 연결 실패");
        } finally {
            busy.current = false;
            setPending(null);
        }
    };
    if (supported === false) return <p className="warn small" role="status">에이전트 연결에는 서버 업데이트가 필요합니다.</p>;
    return <div className="agent-connect" data-testid="agent-connect">
        <span className="small muted">대화할 에이전트</span>
        <div className="inline wrap">
            {catalog.data?.backends.map((backend) => (
                <ServerActionButton key={backend.protocol} className="ghost" disabled={disabled || pending !== null || !backend.installed}
                    onClick={() => void connect(backend.protocol)}>
                    {pending === backend.protocol ? "연결 중…" : backend.name}
                    {!backend.installed && <span className="small muted"> · 설치 필요</span>}
                </ServerActionButton>
            ))}
        </div>
        {catalog.data && <span className="small muted">서버 CLI 계정 · 읽기 전용</span>}
        {authSupported && <details onToggle={(event) => setAccountsOpen(event.currentTarget.open)}>
            <summary>계정 로그인</summary>
            {accountsOpen && catalog.data?.backends.filter((backend) => backend.installed).map((backend) =>
                <AgentLogin key={backend.protocol} protocol={backend.protocol} name={backend.name} disabled={disabled} />)}
        </details>}
        {!catalog.data && !catalog.error && <p className="muted small" role="status">에이전트 확인 중…</p>}
        {!!catalog.error && <p className="err small" role="alert">에이전트를 확인하지 못했어요. <button type="button" className="ghost small" onClick={catalog.reload}>다시 확인</button></p>}
        {error && <p className="err small" role="alert">{error}</p>}
        {connected && <p className="small" role="status">{connected} 프로필 준비됨</p>}
    </div>;
}
