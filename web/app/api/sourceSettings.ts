import { api } from "./client";

// src/source_settings의 안전한 직렬화 계약. 원문·절대 경로·적용값은 포함하지 않는다.
export type SourceId = "claude_user" | "claude_project" | "claude_project_local" | "codex_user" | "codex_project";

export type SafeSettings = {
    alwaysThinkingEnabled?: boolean;
    autoCompactEnabled?: boolean;
    autoMemoryEnabled?: boolean;
    cleanupPeriodDays?: number;
};

export type ReadErrorCode = "permission_denied" | "not_regular_file" | "too_large" | "invalid_json" | "invalid_shape" | "io";

export type SourceSettings = { source: SourceId } & (
    | { status: "present"; projection: SafeSettings; ignored_invalid_fields: boolean }
    | { status: "missing" }
    | { status: "read_error"; code: ReadErrorCode }
    | { status: "unsupported_format"; format: "toml" }
);

export type ResourceState<T> =
    | { status: "present"; entries: T[]; ignored_invalid_entries: boolean }
    | { status: "missing" }
    | { status: "read_error"; code: ReadErrorCode }
    | { status: "unsupported_format"; format: "toml" };

export type SkillMetadata = { name: string; description: string | null; relative_path: string };
export type HookMetadata = { event: string; matcher: string | null; has_command: boolean };
export type SourceResource = { source: SourceId; relative_path: string } & (
    | { kind: "skills"; result: ResourceState<SkillMetadata> }
    | { kind: "hooks"; result: ResourceState<HookMetadata> }
);

export function getSourceSettings(projectId?: string): Promise<{ items: SourceSettings[]; resources: SourceResource[] }> {
    const query = projectId === undefined ? "" : `?${new URLSearchParams({ project_id: projectId })}`;
    return api.get(`/source-settings${query}`);
}
