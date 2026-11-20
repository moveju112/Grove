import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { ApiError, api, newKey } from "../api/client";
import type { AgentAuthStatus } from "../api/generated";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { invalidate } from "../state/store";

const styles = stylex.create({
    steps: { borderTop: "1px solid var(--line)", paddingTop: "var(--spacing-4)" },
    stepNumber: {
        display: "grid", placeItems: "center", width: 20, height: 20, flexShrink: 0,
        border: "1px solid var(--line-strong)", borderRadius: "var(--radius-full)",
    },
    stepBody: { flexGrow: 1, minWidth: 0 },
    external: {
        display: "flex", justifyContent: "center", alignItems: "center", minHeight: 40,
        paddingInline: "var(--spacing-3)", textAlign: "center", borderRadius: "var(--radius-element)",
        backgroundColor: "var(--accent)", color: "var(--on-accent)",
        outline: { default: null, ":focus-visible": "2px solid var(--focus)" }, outlineOffset: 2,
    },
    codeBox: { border: "1px solid var(--line-strong)", backgroundColor: "var(--raised)", borderRadius: "var(--radius-element)" },
});

const active = (status: AgentAuthStatus | null) =>
    ["starting", "waiting", "verifying"].includes(status?.attempt?.state ?? "");
const labels: Record<string, string> = {
    starting: "로그인 준비 중", waiting: "인증 대기", verifying: "인증 확인 중",
    completed: "인증 절차 완료", cancelled: "로그인 취소됨", expired: "로그인 만료됨",
    failed: "로그인 실패. 다시 시도해 주세요.",
};

export function AgentLogin({ protocol, name, disabled, signInOnly = false, showName = true }: {
    protocol: string; name: string; disabled: boolean; signInOnly?: boolean; showName?: boolean;
}) {
    const [status, setStatus] = useState<AgentAuthStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const pending = useRef<{ id: string; previous_id: string | null } | null>(null);
    const mounted = useRef(false);
    const base = `/agent-backends/${protocol}`;
    const terminalOnly = protocol === "claude_code";
    const requirements = { requires: ["agent_auth_v1"] };
    useEffect(() => {
        if (status && !active(status)) invalidate("usage:accounts");
    }, [status?.authenticated, status?.attempt?.state]);
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
                if (active(value)) timer = setTimeout(load, 1000);
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "인증 상태 확인 실패");
            }
        };
        void load();
        return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
    }, [base, refresh]);

    const act = async (action: "login" | "login/cancel" | "logout") => {
        if (busy || disabled || terminalOnly) return;
        if (action === "logout" && !confirm(`${name}의 서버 계정에서 로그아웃할까요? 같은 OS 계정을 사용하는 CLI와 모든 기기의 새 대화에 영향을 줍니다.`)) return;
        setBusy(true);
        setError(null);
        let body: unknown = {};
        if (action === "login") {
            pending.current ??= { id: newKey(), previous_id: status?.attempt?.id ?? null };
            body = pending.current;
        } else if (action === "login/cancel") body = { id: status?.attempt?.id };
        else if (action === "logout") body = { attempt_id: status?.attempt?.id ?? null };
        try {
            const value = await api.post<AgentAuthStatus>(`${base}/${action}`, body, requirements);
            if (!mounted.current) return;
            pending.current = null;
            setStatus(value);
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
    const attempt = terminalOnly ? null : status?.attempt;
    const isActive = !terminalOnly && active(status);
    return <GroveStack as="section" gap={2} paddingBlock={2} aria-label={`${name} 계정`}>
        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
            {showName && <strong>{name}</strong>}
            <GroveText type="supporting" color="secondary" role="status">
                {isActive ? labels[attempt!.state] : status?.authenticated === true ? terminalOnly ? "인증됨" : "로그인됨"
                    : status?.authenticated === false ? terminalOnly ? "인증 필요" : "로그인 필요" : "상태 확인 필요"}
            </GroveText>
            {!terminalOnly && !isActive && !(signInOnly && status?.authenticated) && <>
                <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy || !status}
                    onClick={() => void act("login")}>{status?.authenticated ? "다시 로그인" : "로그인"}</ServerActionButton>
                {status?.authenticated && <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                    onClick={() => void act("logout")}>로그아웃</ServerActionButton>}
            </>}
        </GroveStack>
        {terminalOnly && <GroveText type="supporting" color="secondary">서버 터미널의 <code>claude auth login</code> 또는 Claude Code의 API 키 설정을 사용하세요.</GroveText>}
        {attempt?.url && <GroveStack gap={3} xstyle={styles.steps}>
                {attempt.code && <LoginStep number={1} label="기기 코드 복사">
                    <DeviceCode key={attempt.id} code={attempt.code} />
                </LoginStep>}
                <LoginStep number={attempt.code ? 2 : 1} label="OpenAI 페이지에 코드 입력">
                    <AuthLink url={attempt.url} provider="OpenAI" />
                </LoginStep>
        </GroveStack>}
        {isActive && <GroveStack direction="horizontal" justify="end">
            <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                onClick={() => void act("login/cancel")}>인증 취소</ServerActionButton>
        </GroveStack>}
        {attempt && ["failed", "expired", "cancelled"].includes(attempt.state) && <GroveText as="p" display="block" type="supporting" color="inherit" role="status">{labels[attempt.state]}</GroveText>}
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
        {!isActive && (terminalOnly || error || status?.authenticated == null) &&
            <GroveButton type="button" variant="secondary" density="compact" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>상태 확인</GroveButton>}
    </GroveStack>;
}

function LoginStep({ number, label, children }: { number: number; label: string; children: ReactNode }) {
    return <GroveStack direction="horizontal" align="start" gap={2}>
        <GroveText type="supporting" xstyle={styles.stepNumber}>{number}</GroveText>
        <GroveStack gap={1} xstyle={styles.stepBody}>
            <GroveText type="label">{label}</GroveText>
            {children}
        </GroveStack>
    </GroveStack>;
}

function AuthLink({ url, provider }: { url: string; provider: string }) {
    return <Link xstyle={styles.external} type="label" weight="semibold" href={url} isExternalLink
        newTabLabel="(새 탭에서 열기)" referrerPolicy="no-referrer">{provider} 인증 페이지 열기</Link>;
}

function DeviceCode({ code }: { code: string }) {
    const [result, setResult] = useState<"copied" | "failed" | null>(null);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setResult("copied");
        } catch {
            setResult("failed");
        }
    };
    return <>
        <GroveStack direction="horizontal" align="center" justify="between" wrap="wrap" gap={2} padding={2} xstyle={styles.codeBox}>
            <GroveText type="code" weight="semibold"><code aria-label="기기 인증 코드">{code}</code></GroveText>
            <GroveButton type="button" variant="secondary" density="compact" onClick={() => void copy()}>
                {result === "copied" ? "복사됨" : "복사"}
            </GroveButton>
        </GroveStack>
        {result && <GroveText type="supporting" color="secondary" aria-live="polite" role="status">
            {result === "copied" ? "기기 코드를 복사했어요." : "복사할 수 없어요. 표시된 코드를 직접 입력해 주세요."}
        </GroveText>}
    </>;
}
