import { api } from "../api/client";
import type { SessionPage } from "../api/generated";
import { subscribeQuery } from "./store";

export function historyPage(projectId: string, archived: boolean, cursor = "") {
    const qs = new URLSearchParams({ limit: "30", archived: String(archived), pinned_first: "true" });
    if (cursor) qs.set("cursor", cursor);
    return {
        key: `sessions:${projectId}:history:${qs}`,
        read: () => api.get<SessionPage>(`/projects/${projectId}/sessions?${qs}`),
    };
}

export function prefetchHistory(projectId: string, archived: boolean, cursor = "") {
    const { key, read } = historyPage(projectId, archived, cursor);
    subscribeQuery(key, read, () => undefined)();
}
