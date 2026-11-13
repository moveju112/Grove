import { useState } from "react";
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
        <h3>hook 실행 요청</h3>
        <p className="muted small">최근 100개 · {projectId ? "현재 프로젝트" : "모든 프로젝트"}.
            원래 작업과 별개이며, 매 이벤트마다 새 계획 승인이 필요합니다.</p>
        <button onClick={query.reload}>hook 실행 상태 새로고침</button>
        {query.loading && <p role="status">실행 요청 불러오는 중</p>}
        {(query.error || error) && <p role="alert">{error ?? "hook 실행 요청을 조회하지 못했습니다"}</p>}
        {query.data?.length === 0 && <p>접수된 hook 실행 요청이 없습니다.</p>}
        {query.data?.map((call) => <article key={call.id} data-testid="hook-execution" data-call-id={call.id}>
            <p>대화 <code>{call.session_id}</code> · {statusLabels[call.status] ?? call.status}</p>
            <details><summary>승인 계획 · 이벤트·revision·명령·위치·환경·한도</summary><pre>{JSON.stringify(call.target, null, 2)}</pre></details>
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
                <button disabled={busy !== null} onClick={() => void cancel(call)}>hook 실행 취소</button>}
            {call.status === "unknown" && <p role="alert">결과 불명 · 자동 반복하지 않습니다. 해당 대화의 결과 불명 카드에서 관찰·검토를 기록하세요.</p>}
            {!["pending_approval", "approved", "running"].includes(call.status) && <pre>{JSON.stringify(call.result, null, 2)}</pre>}
        </article>)}
    </section>;
}
