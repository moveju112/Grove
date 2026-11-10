import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";

export type AgentRun = {
    id: string;
    parent_session_id: string;
    child_session_id: string;
    agent_id: string;
    depth: number;
    status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
    result: string | null;
    created_at: string;
};

const LABEL: Record<AgentRun["status"], string> = {
    running: "진행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "취소됨",
    interrupted: "중단됨",
};

export function useAgentRuns(sessionId: string) {
    return useQuery<{ runs: AgentRun[]; parent: AgentRun | null }>(`agent-runs:${sessionId}`, () => api.get(`/sessions/${sessionId}/agent-runs`));
}

/// 이 대화가 맡긴 자식 작업과(자식 대화라면) 부모 연결.
export function AgentRunsPanel({ sessionId, projectId, open, onError }: { sessionId: string; projectId: string; open: Opener; onError: (m: string) => void }) {
    const q = useAgentRuns(sessionId);
    const runs = q.data?.runs ?? [];
    const parent = q.data?.parent;
    const openSession = (id: string, title: string) => open({ kind: "session", project_id: projectId, resource_id: id, title }, "right");
    const cancel = async (id: string) => {
        try {
            await api.post(`/agent-runs/${id}/cancel`);
        } catch (e) {
            onError(e instanceof ApiError ? e.message : "취소 실패");
        }
        q.reload();
    };
    if (!parent && runs.length === 0) return null;
    return (
        <div className="agent-runs" data-testid="agent-runs">
            {parent && (
                <p className="small">
                    자식 작업({parent.agent_id}, {LABEL[parent.status]}) · 결과는 부모 대화에 보고됩니다{" "}
                    <button className="link" onClick={() => openSession(parent.parent_session_id, "부모 대화")}>부모 대화 열기</button>
                </p>
            )}
            {runs.length > 0 && (
                <details open={runs.some((r) => r.status === "running") || undefined}>
                    <summary>
                        맡긴 작업 {runs.length}
                        {runs.some((r) => r.status === "running") && <strong> · 진행 중 {runs.filter((r) => r.status === "running").length}</strong>}
                    </summary>
                    <ul className="session-list">
                        {runs.map((r) => (
                            <li key={r.id} data-testid="agent-run" data-status={r.status}>
                                <span className="chip">{r.agent_id}</span>
                                <span className={`status ${r.status}`}>{LABEL[r.status]}</span>
                                <button className="link" onClick={() => openSession(r.child_session_id, r.agent_id)}>자식 대화</button>
                                {r.status === "running" && <button className="ghost small" onClick={() => void cancel(r.id)}>취소</button>}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}
