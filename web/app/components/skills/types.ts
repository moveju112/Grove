import type { SkillEntry, SkillSelection, SkillSource } from "../../api/skills";
export type { SkillBody, SkillEntry, SkillListing, SkillSelection, SkillSource } from "../../api/skills";

export function sameSource(a: SkillSource, b: SkillSource): boolean {
    return a.kind === b.kind && a.root_id === b.root_id
        && (a.kind !== "project" || (b.kind === "project" && a.project_id === b.project_id));
}

export function sameSelection(a: SkillSelection, b: SkillSelection): boolean {
    return a.id === b.id && sameSource(a.source, b.source) && a.revision === b.revision;
}

export function bindingOf(entry: SkillEntry): SkillSelection {
    return { id: entry.id, source: { ...entry.source }, revision: entry.revision };
}

export function sourceLabel(source: SkillSource): string {
    return source.kind === "project"
        ? `프로젝트 ${source.project_id} · ${source.root_id}`
        : `전역 · ${source.root_id}`;
}

export function selectionStatus(entry: SkillEntry, selected: readonly SkillSelection[]): "none" | "selected" | "stale" {
    const current = selected.find((item) => item.id === entry.id && sameSource(item.source, entry.source));
    return !current ? "none" : sameSelection(current, entry) ? "selected" : "stale";
}
