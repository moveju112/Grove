import type { NativeCommand } from "../api/generated";
import type { SlashCommand } from "./slash";

export type NativeSlashCommand = SlashCommand & { nativeId: string };

// Grove의 기존 명령은 유지하고, 충돌하는 CLI 이름에는 명시적인 namespace를 붙인다.
export function nativeSlashCommands(entries: readonly NativeCommand[], local: readonly SlashCommand[]): NativeSlashCommand[] {
    const names = new Set(local.map((entry) => entry.name.toLowerCase()));
    return entries.map((entry) => {
        let name = entry.name;
        while (names.has(name.toLowerCase())) name = `cli:${name}`;
        names.add(name.toLowerCase());
        return { name, args: entry.argument_hint || undefined, description: `CLI · ${entry.description}`, nativeId: entry.id };
    });
}
