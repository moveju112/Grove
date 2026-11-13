import { api } from "./client";

export type SkillSource =
    | { kind: "global"; root_id: string }
    | { kind: "project"; root_id: string; project_id: string };
export type SkillSelection = { id: string; source: SkillSource; revision: string };
export type SkillEntry = SkillSelection & {
    enabled: boolean;
    name: string;
    symlink: boolean;
    alias_of: string | null;
    priority: "preferred" | "shadowed" | "conflict" | "incomplete";
    conflicts: string[];
    metadata: "none" | "opaque_front_matter";
};
export type SkillBody = { selection: SkillSelection; text: string };
export type SkillListing = {
    entries: SkillEntry[];
    issues: { source: SkillSource; name: string | null; code: string }[];
};
export type SessionSkills = {
    listing: SkillListing;
    selected: SkillSelection[];
    validation_error: { code: string; message: string } | null;
};
export type SkillMutation =
    | { op: "add"; scope: "global" | "project"; name: string; text: string }
    | { op: "save"; selection: SkillSelection; text: string }
    | { op: "set_enabled"; selection: SkillSelection; enabled: boolean };
export type SkillChange = { id: string; revision: string; enabled: boolean };

const path = (session: string) => `/sessions/${encodeURIComponent(session)}/skills`;
export const skillsApi = {
    list: (session: string, signal?: AbortSignal) => api.get<SessionSkills>(path(session), { signal }),
    inspect: (session: string, selection: SkillSelection, signal?: AbortSignal) =>
        api.post<SkillBody>(`${path(session)}/body`, { selection }, { signal }),
    select: (session: string, selection: SkillSelection, selected: boolean, key: string, signal?: AbortSignal) =>
        api.put<{ selected: SkillSelection[] }>(`${path(session)}/selection`, { selection, selected }, { key, signal }),
    manage: (session: string, body: SkillMutation, key: string, signal?: AbortSignal) =>
        api.put<SkillChange>(`${path(session)}/management`, body, { key, signal }),
};
