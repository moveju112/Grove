import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useState } from "react";
import { DetailDialog } from "../ui/Controls";
import { api } from "../../api/client";
import type { ToolCallRow } from "../../api/generated";
import { useQuery } from "../../state/store";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { statusLabels } from "../approvals/projection";

/** 공통 대화 UI의 도구 whitelist를 넓히지 않고 기존 승인 컴포넌트·API를 재사용한다. */
export function HookExecutions({ projectId }: { projectId?: string }) {
    // 기존 tool_call.updated의 recovery invalidation을 재사용한다.
    const query = useQuery<ToolCallRow[]>(`recovery:hook-executions:${projectId ?? "all"}`, () =>
        api.get(`/hooks/executions${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const cancel = async (call: ToolCallRow) => {
        if (busy) return;
        setBusy(call.id); setError(null);
        try {
            await api.post(`/tool-calls/${call.id}/cancel`, {});
        } catch {
            setError("취소 응답을 확인하지 못했습니다. 최신 상태를 확인하세요.");
        } finally {
            setBusy(null); query.reload();
        }
    };
    return <section className="stack" data-testid="hook-executions" aria-label="hook 실행 요청">
        <GroveHeading level={3} color="inherit">hook 실행 요청</GroveHeading>
        <GroveText as="p" display="block" type="inherit" color="inherit" className="scope">최근 100개 · {projectId ? "현재 프로젝트" : "모든 프로젝트"} · 이벤트마다 개별 승인</GroveText>
        <GroveButton onClick={query.reload}>hook 실행 상태 새로고침</GroveButton>
        {query.loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">실행 요청 불러오는 중</GroveText>}
        {(query.error || error) && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">{error ?? "hook 실행 요청을 조회하지 못했습니다"}</GroveText>}
        {query.data?.length === 0 && <GroveText as="p" display="block" type="inherit" color="inherit">접수된 hook 실행 요청이 없습니다.</GroveText>}
        {query.data?.map((call) => <article key={call.id} data-testid="hook-execution" data-call-id={call.id}>
            <GroveText as="p" display="block" type="inherit" color="inherit">대화 <code>{call.session_id}</code> · {statusLabels[call.status] ?? call.status}</GroveText>
            <DetailDialog label="승인 계획" title="승인 계획"><pre>{JSON.stringify(call.target, null, 2)}</pre></DetailDialog>
            {call.status === "pending_approval" && <ApprovalCard call={call} effect="execute" choices={["approve", "deny"]}
                onDecision={async (request) => {
                    try {
                        return await api.post<ToolCallRow>(`/tool-calls/${request.id}/decision`, {
                            decision: request.decision, expected_revision: request.revision,
                        });
                    } finally { query.reload(); }
                }}
                onRefresh={async () => {
                    await api.get(`/tool-calls/${call.id}`);
                    query.reload();
                }} />}
            {["approved", "running"].includes(call.status) &&
                <GroveButton disabled={busy !== null} onClick={() => void cancel(call)}>hook 실행 취소</GroveButton>}
            {call.status === "unknown" && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">결과 불명 · 자동 반복하지 않습니다. 해당 대화의 결과 불명 카드에서 관찰·검토를 기록하세요.</GroveText>}
            {!["pending_approval", "approved", "running"].includes(call.status) && <pre>{JSON.stringify(call.result, null, 2)}</pre>}
        </article>)}
    </section>;
}
