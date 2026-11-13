// Hook 설정 API 계약. command가 가려졌으면 수정 시 생략하여 저장 원문을 유지한다.
export type HookDefinition = {
    name: string; event: string; matcher: string; command: string; enabled: boolean;
};
export type Hook = HookDefinition & {
    id: string; project_id: string | null; revision: number;
    command_redacted: boolean; execution_state: "not_implemented" | "approval_required";
};
export type HookListing = {
    hooks: Hook[]; events: string[]; matcher_syntax: "glob"; execution_state: "not_implemented" | "partial";
    supported_events?: string[]; execution_note?: string;
};
export type HookUpdate = Omit<HookDefinition, "command"> & { expected_revision: number; command?: string };

export function hookPath(projectId?: string, id?: string, revision?: number): string {
    const query = new URLSearchParams();
    if (projectId) query.set("project_id", projectId);
    if (revision !== undefined) query.set("expected_revision", String(revision));
    return `/hooks${id ? `/${encodeURIComponent(id)}` : ""}${query.size ? `?${query}` : ""}`;
}

export function hookUpdate(hook: Hook, draft: HookDefinition, replaceCommand: boolean): HookUpdate {
    return {
        name: draft.name, event: draft.event, matcher: draft.matcher, enabled: draft.enabled,
        expected_revision: hook.revision, ...(replaceCommand ? { command: draft.command } : {}),
    };
}
