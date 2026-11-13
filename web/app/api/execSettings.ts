import type { SettingDef } from "../components/ScopedSettings";

/** 기존 /settings/registry의 실행 설정 전용 capability 메타데이터. */
export type ExecSettingDef = SettingDef & {
    unavailable_options?: { value: string; reason: string }[];
    disabled_reason?: string;
};

export const EXEC_SETTING_KEYS = [
    "exec.shell",
    "exec.max_memory_mb",
    "exec.max_cpu_seconds",
    "exec.isolation",
    "exec.default_cwd",
] as const;

export function isExecSetting(def: SettingDef): boolean {
    return (EXEC_SETTING_KEYS as readonly string[]).includes(def.key);
}
