import { useEffect, useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { AgentAuthStatus } from "../api/generated";
import { ServerActionButton } from "./pwa/ServerActionButton";

const active = (status: AgentAuthStatus | null) =>
    ["starting", "waiting", "verifying"].includes(status?.attempt?.state ?? "");
const labels: Record<string, string> = {
    starting: "로그인 준비 중", waiting: "인증 대기", verifying: "인증 확인 중",
    completed: "인증 절차 완료", cancelled: "로그인 취소됨", expired: "로그인 만료됨",
    failed: "로그인 실패. 다시 시도해 주세요.",
};

export function AgentLogin({ protocol, name, disabled }: { protocol: string; name: string; disabled: boolean }) {
    const [status, setStatus] = useState<AgentAuthStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [code, setCode] = useState("");
    const [refresh, setRefresh] = useState(0);
    const pending = useRef<{ id: string; previous_id: string | null } | null>(null);
    const mounted = useRef(false);
    const base = `/agent-backends/${protocol}`;
    const requirements = { requires: ["agent_auth_v1"] };
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = async () => {
            try {
                const value = await api.getContract("AgentAuthStatus", `${base}/auth`, {
                    ...requirements, signal: controller.signal,
                });
                if (controller.signal.aborted) return;
                setStatus(value);
                setError(null);
                if (!active(value)) setCode("");
                if (active(value)) timer = setTimeout(load, 1000);
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "인증 상태 확인 실패");
            }
        };
        void load();
        return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
    }, [base, refresh]);

    const act = async (action: "login" | "login/code" | "login/cancel" | "logout") => {
        if (busy || disabled) return;
        if (action === "logout" && !confirm(`${name}의 서버 계정에서 로그아웃할까요? 같은 OS 계정을 사용하는 CLI와 모든 기기의 새 대화에 영향을 줍니다.`)) return;
        setBusy(true);
        setError(null);
        let body: unknown = {};
        if (action === "login") {
            pending.current ??= { id: newKey(), previous_id: status?.attempt?.id ?? null };
            body = pending.current;
        } else if (action === "login/code") {
            body = { id: status?.attempt?.id, code: code.trim() };
        } else if (action === "login/cancel") body = { id: status?.attempt?.id };
        else if (action === "logout") body = { attempt_id: status?.attempt?.id ?? null };
        try {
            const value = await api.post<AgentAuthStatus>(`${base}/${action}`, body, requirements);
            if (!mounted.current) return;
            pending.current = null;
            setStatus(value);
            setCode("");
            setRefresh((n) => n + 1);
        } catch (cause) {
            if (cause instanceof ApiError && (cause.status === 400 || cause.status === 409)) {
                pending.current = null;
                if (mounted.current) setRefresh((n) => n + 1);
            }
            if (mounted.current) setError(cause instanceof Error ? cause.message : "인증 요청 실패");
        } finally {
            if (mounted.current) setBusy(false);
        }
    };
    const attempt = status?.attempt;
    return <section className="agent-login" aria-label={`${name} 계정`}>
        <div className="inline wrap">
            <strong>{name}</strong>
            <span className="small muted" role="status">
                {active(status) ? labels[attempt!.state] : status?.authenticated === true ? "로그인됨"
                    : status?.authenticated === false ? "로그인 필요" : "상태 확인 필요"}
            </span>
            {!active(status) && <>
                <ServerActionButton className="ghost small" disabled={disabled || busy || !status}
                    onClick={() => void act("login")}>{status?.authenticated ? "다시 로그인" : "로그인"}</ServerActionButton>
                {status?.authenticated && <ServerActionButton className="ghost small" disabled={disabled || busy}
                    onClick={() => void act("logout")}>로그아웃</ServerActionButton>}
            </>}
            {active(status) && <ServerActionButton className="ghost small" disabled={disabled || busy}
                onClick={() => void act("login/cancel")}>취소</ServerActionButton>}
        </div>
        {attempt?.url && <>
            <p className="small">이 서버에서 사용할 계정으로 인증해 주세요.</p>
            <a href={attempt.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">인증 페이지 열기</a>
            {attempt.code && <p><code aria-label="기기 인증 코드">{attempt.code}</code></p>}
            {protocol === "claude_code" && <form className="inline wrap" onSubmit={(event) => { event.preventDefault(); void act("login/code"); }}>
                <input aria-label="일회용 인증 코드" type="password" autoComplete="off" spellCheck={false}
                    value={code} onChange={(event) => setCode(event.target.value)} placeholder="인증 페이지의 코드"
                    disabled={disabled || busy} />
                <ServerActionButton type="submit" disabled={disabled || busy || !code.trim()}>확인</ServerActionButton>
            </form>}
        </>}
        {attempt && ["failed", "expired", "cancelled"].includes(attempt.state) && <p className="small" role="status">{labels[attempt.state]}</p>}
        {error && <p className="err small" role="alert">{error}</p>}
        {!active(status) && (error || status?.authenticated == null) &&
            <button type="button" className="ghost small" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>상태 확인</button>}
    </section>;
}
