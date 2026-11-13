import { api } from "./client";
import type { ExternalEditorListing } from "./generated.externalEditor";
export type { ExternalEditorListing } from "./generated.externalEditor";

const requires = ["external_editor_v1"];
export const listExternalEditors = (signal?: AbortSignal) =>
    api.get<ExternalEditorListing>("/external-editors", { requires, signal });

export const openExternalEditor = (projectId: string, editorId: string, path: string, key: string) =>
    api.post<{ launched: boolean }>(`/projects/${encodeURIComponent(projectId)}/external-editor`, { editor_id: editorId, path }, { requires, key });
