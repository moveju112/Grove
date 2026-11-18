import { api } from "./client";

export type GitContextState = "ok" | "none" | "unsupported" | "missing" | "unauthenticated" | "denied" | "timeout" | "unknown" | "stale" | "unborn" | "no_remote" | "success" | "failure" | "pending" | "neutral";
export type GitContext = {
    project_id: string;
    status: "ok" | "stale" | "not_repo";
    observed_at?: string;
    location?: {
        branch: string; head: string | null; kind: "branch" | "detached" | "unborn";
        project_relative_to_worktree: string | null;
        worktree: "main" | "linked"; git_registered: boolean; worktree_count: number;
    };
    github?: {
        repository: string | null; remote: string; head: string | null;
        pr: { status: GitContextState; items?: { number: number; state: string; draft: boolean }[] };
        ci: { status: GitContextState; count?: number };
    };
    authority?: {
        authenticated: boolean; tool_mode: string;
        direct_git: "authenticated"; remote_permission: "unknown";
        actions: { id: string; status: "blocked" | "conditional"; reason: string }[];
    };
};

export function readGitContext(projectId: string, head?: string, options?: { cached?: boolean; signal?: AbortSignal }) {
    const query = new URLSearchParams();
    if (head) query.set("head", head);
    if (options?.cached) query.set("cached", "true");
    return api.get<GitContext>(`/projects/${encodeURIComponent(projectId)}/git/context?${query}`, { signal: options?.signal });
}
