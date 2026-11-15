import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useState } from "react";
import { DetailDialog } from "../ui/Controls";
import { ApiError, api } from "../../api/client";
import type { MessagePage } from "../../api/generated";
import { requestFocus } from "../../state/focus";

export type CompactionRecord = {
    summary: string;
    auto: boolean;
    estimated_before?: number;
    estimated_after?: number;
    profile_id?: string;
    generation?: { profile_name: string; protocol: string; model: string };
    pricing?: { currency?: string; version?: string } | null;
    estimated_cost?: number | null;
    cost_status?: "estimated" | "missing_pricing" | "usage_unreported_or_zero";
    usage?: { input_tokens?: number; output_tokens?: number };
    source?: { from_seq: number; upto_seq: number; messages: number };
};

/** 범위 경계의 숫자를 메시지로 가정하지 않고, 보존된 실제 메시지를 조회한다. */
export async function focusCompactionSource(sessionId: string, source: NonNullable<CompactionRecord["source"]>, edge: "first" | "last") {
    const query = edge === "first" ? `after_seq=${source.from_seq}` : `before_seq=${source.upto_seq + 1}`;
    const page = await api.get<MessagePage>(`/sessions/${sessionId}/messages?limit=1&${query}`);
    const target = page.items.find((m) => m.seq > source.from_seq && m.seq <= source.upto_seq);
    if (!target) return false;
    requestFocus(sessionId, target.seq);
    return true;
}

export function CompactionDetails({ sessionId, record: r }: { sessionId: string; record: CompactionRecord }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const navigate = async (edge: "first" | "last") => {
        if (!r.source) return;
        setBusy(true);
        setError(null);
        try {
            if (!await focusCompactionSource(sessionId, r.source, edge)) setError("이 구간의 보존된 원문을 찾을 수 없어 이동할 수 없습니다.");
        } catch (e) {
            setError(e instanceof ApiError ? `원문 조회 실패: ${e.message}` : "원문 조회 실패. 이동하지 않았습니다.");
        } finally {
            setBusy(false);
        }
    };
    const usageKnown = r.usage?.input_tokens != null && r.usage?.output_tokens != null
        && r.usage.input_tokens > 0 && r.usage.output_tokens > 0;
    const costKnown = r.cost_status === "estimated" && r.estimated_cost != null && r.pricing?.currency;
    return <GroveStack gap={2} data-testid="msg-compaction">
    <DetailDialog surface="muted" label="대화 압축 기록" title={<>
            이전 대화 요약({r.auto ? "자동" : "수동"} 압축) · 모델에는 이 요약과 이후 대화만 보냅니다
            {r.estimated_before != null && r.estimated_after != null ? ` · 약 ${r.estimated_before}→${r.estimated_after} tokens` : ""}
        </>}>
        {r.generation ? <GroveText as="p" display="block" type="inherit" color="inherit" data-testid="compaction-model">
            생성 당시 프로필: {r.generation.profile_name} · {r.generation.protocol} · 모델 {r.generation.model}
            <GroveText type="supporting" color="secondary"> · 저장된 실행 기록이며 현재 프로필의 수정·삭제와 무관합니다.</GroveText>
        </GroveText> : <GroveText as="p" display="block" type="inherit" color="inherit" data-testid="compaction-model">기존 압축 기록: 생성 당시 모델 정보 미기록. 현재 프로필로 소급하지 않습니다.</GroveText>}
        <GroveText as="p" display="block" type="inherit" color="inherit" data-testid="compaction-cost">
            {costKnown ? `추정 비용 ${r.estimated_cost!.toLocaleString("en-US", { maximumSignificantDigits: 8 })} ${r.pricing!.currency} · 생성 당시 가격표`
                : !r.generation ? "추정 비용: 기존 기록에 생성 당시 가격 기준 미기록"
                    : `추정 불가: ${!usageKnown ? "사용량 미보고 또는 0(구분 불가)" : ""}${!usageKnown && !r.pricing ? " · " : ""}${!r.pricing ? "가격 미기록" : ""}`}
            {r.pricing && ` · 통화 ${r.pricing.currency ?? "미기록"} · 가격표 version ${r.pricing.version ?? "미기록"}`}
            {costKnown && " · 실제 청구액이 아닙니다."}
        </GroveText>
        <GroveText as="p" display="block" type="supporting" color="secondary">
            {usageKnown ? `요약 사용량 입력 ${r.usage!.input_tokens}·출력 ${r.usage!.output_tokens} tokens`
                : "요약 사용량: 미기록 또는 0(구분 불가)"}
        </GroveText>
        {r.source ? <>
            <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="compaction-source">
                대상 원문 메시지 {r.source.messages}개(#{r.source.from_seq + 1}~#{r.source.upto_seq}) · 원문은 화면 이력에 그대로 남습니다
                {" · 보존된 원문 보기이며 모델 context를 복원하지 않습니다."}
            </GroveText>
            <GroveStack gap={2} direction="horizontal" align="center" wrap="wrap">
                <GroveButton type="button" data-dialog-close disabled={busy} onClick={() => void navigate("first")}>원문 처음으로</GroveButton>
                <GroveButton type="button" data-dialog-close disabled={busy} onClick={() => void navigate("last")}>원문 끝으로</GroveButton>
            </GroveStack>
        </> : <GroveText as="p" display="block" type="supporting" color="secondary">원문 범위 미기록: 이동할 수 없습니다.</GroveText>}
        <GroveText as="div" display="block" type="inherit" color="inherit">{r.summary}</GroveText>
    </DetailDialog>
    {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
    </GroveStack>;
}
