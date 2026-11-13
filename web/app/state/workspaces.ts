// 프로젝트 워크스페이스 모드와 워크스페이스(Grove worktree) 조회. 화면 컴포넌트에 의존하지 않는다.
import { api } from "../api/client";
import type { Project, Worktree } from "../api/generated";
import { useQuery } from "./store";

/// 이 조회가 쓰는 서버 기능(NET-001).
export const WT = ["worktrees_v1"];

export type WorkspaceRow = Worktree & { exists: boolean; dirty_count: number | null; sessions: number };
export type WorkspaceList = { is_repo: boolean; worktrees: WorkspaceRow[]; unowned: { path: string; branch: string | null }[]; removed?: Worktree[] };

/// 프로젝트 단건 조회. 프로젝트 화면·입력창·대화 머리글이 같은 key를 공유한다.
export function useProject(projectId: string) {
    return useQuery<Project>(`project:${projectId}`, () => api.get(`/projects/${projectId}`));
}

/// 워크스페이스 모드. 아직 모르면 null이며, 그동안 워크스페이스 UI를 보이지 않는다.
export function useWorkspaceMode(projectId: string): "single" | "project" | null {
    const mode = useProject(projectId).data?.workspace_mode;
    return mode === "single" || mode === "project" ? mode : null;
}

/// 대화를 시작·이동할 수 있는 워크스페이스(active·경로 존재). 프로젝트 모드가 아니면 조회하지 않는다.
export function useWorkspaces(projectId: string, enabled: boolean): WorkspaceRow[] {
    const q = useQuery<WorkspaceList>(enabled ? `worktrees:${projectId}` : null, () => api.get(`/projects/${projectId}/worktrees`, { requires: WT }));
    return enabled ? (q.data?.worktrees ?? []).filter((w) => w.status === "active" && w.exists) : [];
}
