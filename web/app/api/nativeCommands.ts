import { api } from "./client";

export function nativeCommands(projectId: string, profileId: string, sessionId?: string, worktreeId?: string) {
    const query = new URLSearchParams({ profile_id: profileId });
    if (sessionId) query.set("session_id", sessionId);
    if (worktreeId) query.set("worktree_id", worktreeId);
    return api.getContract("NativeCommandCatalog", `/projects/${encodeURIComponent(projectId)}/native-commands?${query}`);
}
