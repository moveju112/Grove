import { HoverCard } from "@astryxdesign/core/HoverCard";
import { Stack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { ApiError, api } from "../api/client";
import type { ContextUsage } from "../api/generated";
import { Button } from "../design/Button";
import { useLive, useQuery } from "../state/store";
import { contextMeterStyles } from "./context-meter.stylex";
import { ServerActionButton } from "./pwa/ServerActionButton";

type Usage = {
    context_window: number | null;
    estimated_tokens: number;
    measured_input_tokens: number | null;
    basis: "measured" | "estimated" | "native";
    percent: number | null;
    tokens: number;
    reserve_tokens: number;
    available_tokens: number | null;
    auto_clear_minutes?: number;
    cleared?: { upto_seq: number } | null;
};

/// 대화 context 사용량(실측/추정 구분)과 수동 압축.
export function ContextMeter({ sessionId, profileId, activeTurnId, busy, onError }: { sessionId: string; profileId: string | null; activeTurnId?: string; busy: boolean; onError: (m: string) => void }) {
    const q = useQuery<Usage>(`context:${sessionId}:${profileId ?? "-"}`, () =>
        api.get(`/sessions/${sessionId}/context${profileId ? `?profile_id=${profileId}` : ""}`),
    );
    const [working, setWorking] = useState(false);
    const live = useLive((state) => {
        const snapshot = state.partials[sessionId] as { turn_id: string; profile_id?: string; context_usage?: ContextUsage | null } | undefined;
        return activeTurnId && snapshot?.turn_id === activeTurnId && snapshot.profile_id === profileId ? snapshot.context_usage : undefined;
    });
    const u = live?.tokens != null && q.data ? {
        ...q.data,
        basis: "native" as const,
        tokens: live.tokens,
        context_window: live.context_window,
        percent: live.context_window ? Math.round(live.tokens / live.context_window * 1000) / 10 : null,
        available_tokens: live.context_window === null ? null : live.context_window - live.tokens - q.data.reserve_tokens,
    } : q.data;
    if (!u) return null;
    const tokens = u.tokens;
    const short = u.available_tokens !== null && u.available_tokens < 0;
    const warning = short || (u.percent !== null && u.percent >= 80);
    const progress = u.percent === null ? null : Math.max(0, Math.min(100, u.percent));
    const label =
        u.percent !== null
            ? `${u.percent}% · ${tokens.toLocaleString()}/${u.context_window!.toLocaleString()}`
            : `${tokens.toLocaleString()} tokens`;
    const basisLabel = u.basis === "native" ? "CLI 보고값" : u.basis === "estimated" ? "추정" : "실측 기반";
    const compact = async () => {
        if (!profileId) return;
        setWorking(true);
        try {
            const r = await api.post<{ compacted: boolean; reason?: string }>(`/sessions/${sessionId}/compact`, { profile_id: profileId });
            if (!r.compacted) onError(r.reason ?? "압축할 내용이 없습니다");
        } catch (e) {
            onError(e instanceof ApiError ? e.message : "압축 실패");
        } finally {
            setWorking(false);
            q.reload();
        }
    };
    return (
        <HoverCard label="context 사용량" placement="above" alignment="end" touchTrigger="tap"
            content={<Stack gap={2} maxWidth={280} data-testid="context-meter">
            <GroveText type="supporting" color={warning ? "warning" : "secondary"}>
                context {label} ({basisLabel})
            </GroveText>
            <GroveText type="supporting" color="secondary">
                {u.basis === "native" ? "CLI가 보고한 현재 컨텍스트 사용량" : u.basis === "measured" ? "마지막 응답의 실측 input token + 이후 메시지 추정" : "문자 수 기반 추정(실측 아님)"}
                {u.context_window === null && " · 컨텍스트 한도 미확인"}
                {" · "}출력·다음 입력 여유 {u.reserve_tokens.toLocaleString()} tokens
            </GroveText>
            {short && <GroveText type="supporting" color="warning" data-testid="context-short">여유 부족(압축 권장)</GroveText>}
            {u.cleared && <GroveText type="supporting" color="secondary" data-testid="context-cleared">이전 context 제외됨(화면 이력 유지)</GroveText>}
            {!!u.auto_clear_minutes && <GroveText type="supporting" color="secondary">idle {u.auto_clear_minutes}분 뒤 다음 요청에서 초기화</GroveText>}
            <ServerActionButton type="button" variant="secondary" density="compact" disabled={!profileId || busy || working} onClick={() => void compact()}>
                {working ? "압축 중…" : "압축"}
            </ServerActionButton>
            </Stack>}>
            <Button type="button" appearance="icon" aria-label="context 사용량"
                aria-description={`${label} · ${basisLabel}${u.context_window === null ? " · 컨텍스트 한도 미확인" : ""}`}
                xstyle={warning && contextMeterStyles.warning}>
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...stylex.props(contextMeterStyles.ring)}>
                    <circle cx="12" cy="12" r="9" strokeWidth="2" {...stylex.props(contextMeterStyles.track)} />
                    {progress !== null && progress > 0 && <circle cx="12" cy="12" r="9" strokeWidth="2" pathLength="100"
                        stroke="currentColor" strokeLinecap="round" transform="rotate(-90 12 12)"
                        strokeDasharray={`${progress} ${100 - progress}`} />}
                </svg>
            </Button>
        </HoverCard>
    );
}
