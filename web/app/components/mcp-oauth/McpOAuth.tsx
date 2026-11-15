import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useRef, useState } from "react";
import { newKey } from "../../api/client";
import { callbackData, mcpOAuth, uncertain, type McpOAuthConfig, type OAuthAttempt, type OAuthStarted, type OAuthStatus } from "../../api/mcpOAuth";
import { HelpTip, SentenceText } from "../HelpTip";

type Props = { serverId: string; revision: number; resource: string; config: McpOAuthConfig; disabled: boolean; onChanged: () => void };
const statuses = {
    pending: "승인 대기", exchanging: "토큰 교환 중", completed: "OAuth 완료 · MCP 연결 확인 필요",
    cancelled: "취소됨", expired: "승인 기한 만료", failed: "OAuth 거절 또는 교환 실패",
    unknown: "교환 결과 불명 · 재교환 금지 · 새 연결 필요", interrupted: "재시작으로 승인 요청 폐기",
};

export function McpOAuth({ serverId, revision, resource, config, disabled, onChanged }: Props) {
    const [status, setStatus] = useState<OAuthStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [unknown, setUnknown] = useState<OAuthAttempt | null>(null);
    const [authorization, setAuthorization] = useState<string | null>(null);
    const busy = useRef(false);
    const popup = useRef<Window | null>(null);
    const pending = useRef<{ id: string; state: string; revision: number } | null>(null);
    const reload = async () => {
        try { setStatus(await mcpOAuth.status(serverId)); }
        catch (e) { setError(e instanceof Error ? e.message : "OAuth 상태 조회 실패"); }
    };
    useEffect(() => { void reload(); }, [serverId, revision]);
    const send = async (attempt: OAuthAttempt) => {
        if (busy.current) return;
        busy.current = true; setSending(true); setError(null);
        try {
            const result = await mcpOAuth.send(serverId, attempt);
            setUnknown(null);
            if (attempt.action === "connect") {
                const start = result as OAuthStarted;
                if (start.authorization_url) {
                    const url = new URL(start.authorization_url);
                    pending.current = { id: start.attempt_id, state: url.searchParams.get("state") ?? "", revision: status?.revision ?? revision };
                    setAuthorization(start.authorization_url);
                } else {
                    setError("승인 URL 응답이 유실됐습니다. 상태를 확인하고 대기 요청을 취소한 뒤 새로 연결하세요.");
                }
            } else {
                setAuthorization(null); pending.current = null;
            }
            onChanged();
        } catch (e) {
            setUnknown(uncertain(e) ? attempt : null);
            setError(e instanceof Error ? e.message : "OAuth 요청 실패");
        } finally {
            await reload();
            busy.current = false; setSending(false);
        }
    };
    useEffect(() => {
        const receive = (event: MessageEvent) => {
            const active = pending.current;
            if (!active || busy.current) return;
            const data = callbackData(event, location.origin, popup.current, active.state);
            if (!data) return;
            // 중복 message는 무시한다. 결과 유실 시 같은 receipt만 명시적으로 확인한다.
            pending.current = null;
            setAuthorization(null);
            void send({ action: "complete", key: newKey(), body: {
                expected_revision: active.revision, attempt_id: active.id, state: data.state,
                code: data.code, error: data.error, iss: data.iss,
            } });
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    });
    const active = status?.attempt && ["pending", "exchanging"].includes(status.attempt.status);
    const expected_revision = status?.revision ?? revision;
    const blocked = disabled || sending || !!unknown || !status;
    return <GroveStack as="section" gap={2} aria-label="MCP OAuth">
        <GroveStack as="p" direction="horizontal" align="center" gap={1.5}><GroveText type="supporting" color="inherit">OAuth</GroveText> <HelpTip label="MCP OAuth 도움말">
            <SentenceText text="사전 등록 client 전용이며 S256 PKCE·Bearer·issuer 응답을 확인합니다. 자동 등록·자동 갱신은 하지 않습니다. 승인 창이나 설정 화면을 잃으면 상태 확인 후 대기 요청을 취소하세요." />
        </HelpTip></GroveStack>
        <GroveText as="div" type="supporting" display="block"><dl>
            <dt>승인 URL</dt><dd>{config.authorization_endpoint}</dd>
            <dt>토큰 전송 대상</dt><dd>{config.token_endpoint}</dd>
            <dt>MCP resource</dt><dd>{resource}</dd>
            <dt>issuer</dt><dd>{config.issuer}</dd>
            <dt>scope</dt><dd>{config.scopes.join(" ") || "(없음)"}</dd>
            <dt>등록 반환 URL</dt><dd>{config.redirect_uri}</dd>
        </dl></GroveText>
        <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{status?.attempt ? statuses[status.attempt.status] : "OAuth 미연결"}
            {status?.credential && ` · 자격 ${status.credential.usable ? "사용 가능" : "만료 또는 비활성"} · ${status.credential.expires_at}`}</GroveText>
        {status?.attempt?.status === "pending" && <GroveText as="p" display="block" type="inherit" color="inherit">승인 기한: {status.attempt.expires_at}</GroveText>}
        <GroveStack direction="horizontal" align="center" gap={1.5}>
            <GroveButton type="button" disabled={blocked || !!active} onClick={() => void send({
                action: "connect", key: newKey(), body: { expected_revision, confirmed: true },
            })}>OAuth 연결 시작</GroveButton>
            <GroveButton type="button" disabled={blocked || !!active || !status?.credential?.refresh_available} onClick={() => void send({
                action: "refresh", key: newKey(), body: { expected_revision, confirmed: true },
            })}>OAuth 자격 명시적 갱신</GroveButton>
            {active && <GroveButton type="button" disabled={sending || !!unknown} onClick={() => void send({
                action: "cancel", key: newKey(), body: { expected_revision, attempt_id: status!.attempt!.id },
            })}>OAuth 연결 취소</GroveButton>}
            <GroveButton type="button" disabled={sending} onClick={() => { void reload(); onChanged(); }}>OAuth 상태 확인</GroveButton>
        </GroveStack>
        {authorization && status?.attempt?.status === "pending" && <GroveStack gap={0}>
            <GroveText as="p" display="block" type="inherit" color="inherit">표시된 issuer·scope를 확인하고 승인하세요.</GroveText>
            <GroveButton type="button" disabled={blocked} onClick={() => {
                popup.current = window.open(authorization, "_blank", "popup,width=680,height=760");
                if (!popup.current) setError("승인 창이 차단됐습니다. 브라우저에서 팝업을 허용한 뒤 다시 여세요.");
            }}>OAuth 승인 페이지 열기</GroveButton>
        </GroveStack>}
        {!!error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {unknown && <GroveStack gap={0} role="group" aria-label="OAuth 결과 재확인">
            <GroveText as="p" display="block" type="inherit" color="inherit">접수됐을 수 있으니 같은 키의 결과만 확인하세요.</GroveText>
            <GroveButton type="button" disabled={sending} onClick={() => void send(unknown)}>같은 OAuth 요청 결과 확인</GroveButton>
        </GroveStack>}
        <GroveText as="p" display="block" type="supporting" color="secondary">완료·갱신 후 MCP 연결 확인과 새 도구 승인이 필요하며, unknown 자격은 재사용하지 않습니다.</GroveText>
    </GroveStack>;
}
