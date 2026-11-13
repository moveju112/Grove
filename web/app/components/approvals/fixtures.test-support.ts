import type { ToolCallRow } from "../../api/generated";

export function approvalFixture(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
    return {
        id: "call-1", session_id: "session-1", project_id: "project-1", turn_id: null, provider_call_id: null,
        name: "write", args: { path: "note.txt", content: "not-for-display" }, target: { path: "note.txt", bytes: 15 },
        status: "pending_approval", needs_approval: true, revision: 1, result: null,
        expires_at: "2099-01-01T00:00:00Z", created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:00Z",
        decided_at: null, started_at: null, finished_at: null, reviewed_at: null, review: null, approval_scope: null,
        ...overrides,
    };
}
