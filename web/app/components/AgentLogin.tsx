import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { AgentAuthStatus } from "../api/generated";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { TextInput } from "../design/Fields";

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
    return <GroveStack as="section" gap={2} paddingBlock={2} aria-label={`${name} 계정`}>
        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
            <strong>{name}</strong>
            <GroveText type="supporting" color="secondary" role="status">
                {active(status) ? labels[attempt!.state] : status?.authenticated === true ? "로그인됨"
                    : status?.authenticated === false ? "로그인 필요" : "상태 확인 필요"}
            </GroveText>
            {!active(status) && <>
                <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy || !status}
                    onClick={() => void act("login")}>{status?.authenticated ? "다시 로그인" : "로그인"}</ServerActionButton>
                {status?.authenticated && <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                    onClick={() => void act("logout")}>로그아웃</ServerActionButton>}
            </>}
            {active(status) && <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                onClick={() => void act("login/cancel")}>취소</ServerActionButton>}
        </GroveStack>
        {attempt?.url && <>
            <GroveText as="p" display="block" type="supporting" color="inherit">이 서버에서 사용할 계정으로 인증해 주세요.</GroveText>
            <Link type="inherit" href={attempt.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">인증 페이지 열기</Link>
            {attempt.code && <GroveText as="p" display="block" type="inherit" color="inherit"><code aria-label="기기 인증 코드">{attempt.code}</code></GroveText>}
            {protocol === "claude_code" && <GroveStack as="form" gap={1.5} direction="horizontal" align="center" wrap="wrap" onSubmit={(event) => { event.preventDefault(); void act("login/code"); }}>
                <TextInput label="일회용 인증 코드" isLabelHidden type="password" autoComplete="off" hasSpellCheck={false}
                    value={code} onChange={setCode} placeholder="인증 페이지의 코드"
                    isDisabled={disabled || busy} />
                <ServerActionButton type="submit" disabled={disabled || busy || !code.trim()}>확인</ServerActionButton>
            </GroveStack>}
        </>}
        {attempt && ["failed", "expired", "cancelled"].includes(attempt.state) && <GroveText as="p" display="block" type="supporting" color="inherit" role="status">{labels[attempt.state]}</GroveText>}
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
        {!active(status) && (error || status?.authenticated == null) &&
            <GroveButton type="button" variant="secondary" density="compact" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>상태 확인</GroveButton>}
    </GroveStack>;
}
