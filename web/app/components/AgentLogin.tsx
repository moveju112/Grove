import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { ApiError, api, newKey } from "../api/client";
import type { AgentAuthStatus, LoginAttempt } from "../api/generated";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { invalidate } from "../state/store";
import { Heading } from "@astryxdesign/core/Text";
import { HelpTip, SentenceText } from "./HelpTip";
import { CreationDialog } from "./create/CreationDialog";
import { Icon } from "./icons";

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
    srOnly: {
        position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden",
        clip: "rect(0 0 0 0)", whiteSpace: "nowrap", borderWidth: 0,
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

const AUTH_CHANGED = "grove:agent-auth-changed";
const authKey = (protocol: string) => protocol === "codex_oauth" ? "codex_cli" : protocol;

// 여러 프로필 행이 같은 CLI 계정을 동시에 조회해도 CLI 상태 확인은 한 번만 실행한다.
const inflight = new Map<string, Promise<AgentAuthStatus>>();
function fetchStatus(protocol: string) {
    const key = authKey(protocol);
    let request = inflight.get(key);
    if (!request) {
        request = api.getContract("AgentAuthStatus", `/agent-backends/${protocol}/auth`, { requires: ["agent_auth_v1"] })
            .finally(() => inflight.delete(key));
        inflight.set(key, request);
    }
    return request;
}

/// 같은 CLI 계정을 보여 주는 여러 화면(계정 로그인·모델 프로필 행)이 로그인·로그아웃 결과를 함께 다시 읽는다.
function useAgentAuth(protocol: string, name: string, disabled: boolean) {
    const [status, setStatus] = useState<AgentAuthStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const pending = useRef<{ id: string; previous_id: string | null } | null>(null);
    const mounted = useRef(false);
    const base = `/agent-backends/${protocol}`;
    const terminalOnly = protocol === "claude_code";
    const requirements = { requires: ["agent_auth_v1"] };
    const recheck = () => setRefresh((n) => n + 1);
    useEffect(() => {
        if (status && !active(status)) invalidate("usage:accounts");
    }, [status?.authenticated, status?.attempt?.state]);
    useEffect(() => {
        const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === authKey(protocol)) recheck(); };
        window.addEventListener(AUTH_CHANGED, changed);
        return () => window.removeEventListener(AUTH_CHANGED, changed);
    }, [protocol]);
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = async () => {
            try {
                const value = await fetchStatus(protocol);
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
            pending.current = null;
            if (mounted.current) setStatus(value);
            inflight.delete(authKey(protocol));
            window.dispatchEvent(new CustomEvent(AUTH_CHANGED, { detail: authKey(protocol) }));
        } catch (cause) {
            if (cause instanceof ApiError && (cause.status === 400 || cause.status === 409)) {
                pending.current = null;
                if (mounted.current) recheck();
            }
            if (mounted.current) setError(cause instanceof Error ? cause.message : "인증 요청 실패");
        } finally {
            if (mounted.current) setBusy(false);
        }
    };
    const attempt = terminalOnly ? null : status?.attempt ?? null;
    const isActive = !terminalOnly && active(status);
    const label = isActive ? labels[attempt!.state] : status?.authenticated === true ? terminalOnly ? "인증됨" : "로그인됨"
        : status?.authenticated === false ? terminalOnly ? "인증 필요" : "로그인 필요" : "상태 확인 필요";
    return { status, error, busy, act, recheck, terminalOnly, attempt, isActive, label };
}

export function AgentLogin({ protocol, name, disabled, signInOnly = false, showName = true }: {
    protocol: string; name: string; disabled: boolean; signInOnly?: boolean; showName?: boolean;
}) {
    const { status, error, busy, act, recheck, terminalOnly, attempt, isActive, label } = useAgentAuth(protocol, name, disabled);
    return <GroveStack as="section" gap={2} paddingBlock={2} aria-label={`${name} 계정`}>
        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
            {showName && <strong>{name}</strong>}
            <GroveText type="supporting" color="secondary" role="status">
                {label}
            </GroveText>
            {!terminalOnly && !isActive && !(signInOnly && status?.authenticated) && <>
                <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy || !status}
                    onClick={() => void act("login")}>{status?.authenticated ? "다시 로그인" : "로그인"}</ServerActionButton>
                {status?.authenticated && <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                    onClick={() => void act("logout")}>로그아웃</ServerActionButton>}
            </>}
        </GroveStack>
        {terminalOnly && <GroveText type="supporting" color="secondary">서버 터미널의 <code>claude auth login</code> 또는 Claude Code의 API 키 설정을 사용하세요.</GroveText>}
        {attempt?.url && <LoginSteps attempt={attempt} url={attempt.url} />}
        {isActive && <GroveStack direction="horizontal" justify="end">
            <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                onClick={() => void act("login/cancel")}>인증 취소</ServerActionButton>
        </GroveStack>}
        {attempt && ["failed", "expired", "cancelled"].includes(attempt.state) && <GroveText as="p" display="block" type="supporting" color="inherit" role="status">{labels[attempt.state]}</GroveText>}
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
        {!isActive && (terminalOnly || error || status?.authenticated == null) &&
            <GroveButton type="button" variant="secondary" density="compact" disabled={busy} onClick={recheck}>상태 확인</GroveButton>}
    </GroveStack>;
}

function LoginSteps({ attempt, url }: { attempt: LoginAttempt; url: string }) {
    return <GroveStack gap={3} xstyle={styles.steps}>
                {attempt.code && <LoginStep number={1} label="기기 코드 복사">
                    <DeviceCode key={attempt.id} code={attempt.code} />
                </LoginStep>}
                <LoginStep number={attempt.code ? 2 : 1} label="OpenAI 페이지에 코드 입력">
                    <AuthLink url={url} provider="OpenAI" />
                </LoginStep>
        </GroveStack>;
}

/// 모델 프로필 행에 붙는 한 줄 계정 상태. 기기 코드 단계는 행을 늘리지 않도록 대화상자로 연다.
export function AgentAccount({ protocol, name, disabled }: { protocol: string; name: string; disabled: boolean }) {
    const { status, error, busy, act, recheck, terminalOnly, attempt, isActive, label } = useAgentAuth(protocol, name, disabled);
    const [dismissed, setDismissed] = useState<string | null>(null);
    // 확인 중에는 조용히 기다리고, 결과나 실패가 생긴 뒤에만 표시한다.
    if (!status && !error) return null;
    const hidden = isActive && attempt !== null && dismissed === attempt.id;
    // 로그인·로그아웃 버튼이 상태를 대신 말하므로 그때는 상태 문구를 화면에서 빼고 보조 기술에만 남긴다.
    const action = !terminalOnly && !isActive && status?.authenticated != null;
    return <GroveStack gap={1} role="group" aria-label={`${name} 계정`}>
        <GroveStack direction="horizontal" align="center" gap={1.5}>
            {status && <GroveText type="supporting" color="secondary" role="status" xstyle={action ? styles.srOnly : undefined}>{label}</GroveText>}
            {terminalOnly && status?.authenticated === false && <HelpTip label={`${name} 인증 방법`}>
                <SentenceText text="서버 터미널에서 claude auth login을 실행하거나 Claude Code의 API 키를 설정하세요." />
            </HelpTip>}
            {hidden && <GroveButton type="button" variant="secondary" density="compact" onClick={() => setDismissed(null)}>인증 계속</GroveButton>}
            {!terminalOnly && !isActive && status?.authenticated === true && <ServerActionButton variant="secondary" density="compact"
                disabled={disabled || busy} onClick={() => void act("logout")}>로그아웃</ServerActionButton>}
            {!terminalOnly && !isActive && status?.authenticated === false && <ServerActionButton density="compact"
                disabled={disabled || busy} onClick={() => { setDismissed(null); void act("login"); }}>로그인</ServerActionButton>}
            {!isActive && (error || status?.authenticated == null) && <GroveButton type="button" variant="secondary" density="compact"
                disabled={busy} onClick={recheck}>상태 확인</GroveButton>}
        </GroveStack>
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
        {isActive && attempt && !hidden && <CreationDialog label={`${name} 로그인`} onClose={() => setDismissed(attempt.id)}>
            <GroveStack as="header" direction="horizontal" align="center" justify="between" gap={3}>
                <Heading level={2}>{name} 로그인</Heading>
                <GroveButton type="button" variant="secondary" appearance="icon" aria-label="닫기" onClick={() => setDismissed(attempt.id)}><Icon name="close" /></GroveButton>
            </GroveStack>
            <GroveText type="supporting" color="secondary" role="status">{label}</GroveText>
            {attempt.url && <LoginSteps attempt={attempt} url={attempt.url} />}
            <GroveStack direction="horizontal" justify="end">
                <ServerActionButton variant="secondary" density="compact" disabled={disabled || busy}
                    onClick={() => void act("login/cancel")}>인증 취소</ServerActionButton>
            </GroveStack>
        </CreationDialog>}
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
