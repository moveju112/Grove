import type { SourceResource, SourceSettings } from "../../api/sourceSettings";
export type { ReadErrorCode, SafeSettings, SourceId, SourceSettings } from "../../api/sourceSettings";

export type SourceSettingsView =
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; items: readonly SourceSettings[]; resources?: readonly SourceResource[] };

export type SourceSettingsPanelProps = { view: SourceSettingsView };
