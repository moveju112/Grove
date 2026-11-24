import { StatusBadge } from "../design/StatusBadge";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { ApiError, api } from "../api/client";
import { Panel } from "./ui/Controls";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { PendingServerActionButton } from "./pwa/ServerActionButton";

export type AgentRun = {
    id: string;
    parent_session_id: string;
    child_session_id: string;
    agent_id: string;
    depth: number;
    status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
    result: string | null;
    created_at: string;
    /// 마지막 자식 턴 상태. 질문만 기다리면 awaiting_input.
    turn_status?: string | null;
};

const LABEL: Record<AgentRun["status"], string> = {
    running: "진행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "취소됨",
    interrupted: "중단됨",
};

/// 진행 중인 자식 작업이 지금 무엇을 하는지(WORKFLOW-007). 승인·답변 대기는 사용자가 자식 대화에서 처리해야 한다.
const WAITING: Record<string, string> = {
    queued: "시작 대기",
    awaiting_approval: "승인 대기",
    awaiting_input: "답변 대기",
};

export function runLabel(r: Pick<AgentRun, "status" | "turn_status">): { text: string; needsUser: boolean } {
    const waiting = r.status === "running" && r.turn_status ? WAITING[r.turn_status] : undefined;
    return waiting
        ? { text: waiting, needsUser: r.turn_status === "awaiting_approval" || r.turn_status === "awaiting_input" }
        : { text: LABEL[r.status], needsUser: false };
}

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
    if (!parent && runs.length === 0) return <Panel data-testid="agent-runs" title="맡긴 작업">
        <GroveText as="p" display="block" type="supporting" color={q.error ? "error" : "secondary"} role={q.error ? "alert" : "status"}>
            {q.loading ? "불러오는 중…" : q.error ? "맡긴 작업을 읽지 못했습니다." : "맡긴 작업 없음"}
        </GroveText>
    </Panel>;
    return (
        <GroveStack gap={0} data-testid="agent-runs">
            {parent && (
                <GroveText as="p" display="block" type="supporting" color="inherit">
                    자식 작업({parent.agent_id}, {runLabel(parent).text}) · 결과는 부모 대화에 보고됩니다{" "}
                    <GroveButton appearance="link" onClick={() => openSession(parent.parent_session_id, "부모 대화")}>부모 대화 열기</GroveButton>
                </GroveText>
            )}
            {runs.length > 0 && (
                <Panel title={<>
                        맡긴 작업 {runs.length}
                        {runs.some((r) => r.status === "running") && <strong> · 진행 중 {runs.filter((r) => r.status === "running").length}</strong>}
                        {runs.some((r) => runLabel(r).needsUser) && <strong> · 확인 필요 {runs.filter((r) => runLabel(r).needsUser).length}</strong>}
                    </>}>
                    <GroveList density="compact" edge="flush" hasDividers>
                        {runs.map((r) => (
                            <GroveListItem key={r.id} data-testid="agent-run" data-status={r.status} data-turn-status={r.turn_status ?? ""} label={<>
                                <GroveText type="supporting" color="secondary">{r.agent_id}</GroveText>
                                <StatusBadge status={runLabel(r).needsUser ? "awaiting_approval" : r.status}>{runLabel(r).text}</StatusBadge>
                                <GroveButton appearance="link" onClick={() => openSession(r.child_session_id, r.agent_id)}>자식 대화</GroveButton>
                                {r.status === "running" && <PendingServerActionButton variant="secondary" density="compact" pendingLabel="취소 요청 중…" action={() => cancel(r.id)}>취소</PendingServerActionButton>}
                            </>} />
                        ))}
                    </GroveList>
                </Panel>
            )}
        </GroveStack>
    );
}
