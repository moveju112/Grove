import type { SettingDef } from "../components/ScopedSettings";

export const EXEC_SETTING_KEYS = ["exec.shell"] as const;

export function isExecSetting(def: SettingDef): boolean {
    return (EXEC_SETTING_KEYS as readonly string[]).includes(def.key);
}
