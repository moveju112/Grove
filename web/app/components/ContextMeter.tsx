import { Text as GroveText } from "@astryxdesign/core/Text";
import { useState } from "react";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";

type Usage = {
    context_window: number | null;
    estimated_tokens: number;
    measured_input_tokens: number | null;
    basis: "measured" | "estimated";
    percent: number | null;
    tokens: number;
    reserve_tokens: number;
    available_tokens: number | null;
    auto_clear_minutes?: number;
    cleared?: { upto_seq: number } | null;
    memory_input_tokens?: number;
};

/// 대화 context 사용량(실측/추정 구분)과 수동 압축.
export function ContextMeter({ sessionId, profileId, busy, onError }: { sessionId: string; profileId: string | null; busy: boolean; onError: (m: string) => void }) {
    const q = useQuery<Usage>(`context:${sessionId}:${profileId ?? "-"}`, () =>
        api.get(`/sessions/${sessionId}/context${profileId ? `?profile_id=${profileId}` : ""}`),
    );
    const [working, setWorking] = useState(false);
    const u = q.data;
    if (!u) return null;
    const tokens = u.tokens;
    const short = u.available_tokens !== null && u.available_tokens < 0;
    const label =
        u.percent !== null
            ? `${u.percent}% · ${tokens.toLocaleString()}/${u.context_window!.toLocaleString()}`
            : `${tokens.toLocaleString()} tokens`;
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
        <span
            className="context-meter small"
            data-testid="context-meter"
            title={`${u.basis === "measured" ? "마지막 응답의 실측 input token + 이후 메시지 추정" : "문자 수 기반 추정(실측 아님)"} · 출력·다음 입력 여유 ${u.reserve_tokens.toLocaleString()} tokens`}
        >
            <GroveText type="inherit" color={short || (u.percent !== null && u.percent >= 80) ? "warning" : "secondary"}>
                context {label} {u.basis === "estimated" ? "(추정)" : "(실측 기반)"}
            </GroveText>
            {short && <GroveText type="inherit" color="warning" data-testid="context-short"> · 여유 부족(압축 권장)</GroveText>}
            {u.cleared && <GroveText type="inherit" color="secondary" data-testid="context-cleared"> · 이전 context 제외됨(화면 이력 유지)</GroveText>}
            {!!u.memory_input_tokens && <GroveText type="supporting" color="secondary"> · 기억 입력 추정 {u.memory_input_tokens.toLocaleString()} tokens 포함</GroveText>}
            {!!u.auto_clear_minutes && <GroveText type="supporting" color="secondary"> · idle {u.auto_clear_minutes}분 뒤 다음 요청에서 초기화</GroveText>}
            <ServerActionButton className="ghost small" disabled={!profileId || busy || working} onClick={() => void compact()}>
                {working ? "압축 중…" : "압축"}
            </ServerActionButton>
        </span>
    );
}
