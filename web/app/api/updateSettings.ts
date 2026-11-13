// 서버 업데이트 설정 계약. PWA 자산 갱신과 별개이며 적용 실행 API는 제공하지 않는다.
export type UpdateChannel = "stable" | "beta";
export type AutoApplyScope = "notify_only" | "patch" | "minor";
export type ServerUpdatePreferences = { channel: UpdateChannel; auto_apply: AutoApplyScope; revision: number };
export type SaveUpdatePreferences = Omit<ServerUpdatePreferences, "revision"> & { expected_revision: number };
export type UpdateCheck = {
    status: "available" | "up_to_date" | "failed";
    channel: UpdateChannel;
    checked_at: string;
    settings_revision: number;
    error?: string;
    release?: {
        current: string; available: string; kind: "upgrade" | "same" | "downgrade";
        channel: UpdateChannel; platform: string; artifact: boolean; protocol: number; schema: number;
    };
};
export type ServerUpdateStatus = {
    server: { version: string; protocol: number; schema: number };
    settings: ServerUpdatePreferences;
    last_check: UpdateCheck | null;
    can_manage: boolean;
    readiness: { idle: boolean; busy: Record<string, number> };
    automatic_application: "not_enabled";
};
