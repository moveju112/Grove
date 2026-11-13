// src/source_settings/mod.rs의 직렬화 계약. 공통 API 생성 연결 전에는 이 범위에서만 사용한다.
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

export type SourceSettingsView =
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; items: readonly SourceSettings[] };

export type SourceSettingsPanelProps = { view: SourceSettingsView };
