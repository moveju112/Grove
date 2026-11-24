import { ApiError, api } from "../../api/client";
import type { RecentItem, Session } from "../../api/generated";
import { retryIntent } from "../../state/recentPatch";
import { invalidate } from "../../state/store";

export type SidebarSession = {
    session: Session;
    status: string;
    pinned: boolean;
    recent_id: string | null;
    recent_revision: number | null;
};

export type SidebarPage = {
    items: SidebarSession[];
    statuses: Record<string, number>;
    unread: number;
    total: number;
    filtered_total: number;
    next_offset: number | null;
};

export const STATUS: Record<string, { label: string; icon: string }> = {
    awaiting_approval: { label: "승인 대기", icon: "◇" },
    awaiting_input: { label: "답변 대기", icon: "?" },
    running: { label: "실행 중", icon: "▶" },
    queued: { label: "실행 대기", icon: "◷" },
    unknown_result: { label: "결과 확인 필요", icon: "!" },
    unknown: { label: "상태 확인 필요", icon: "?" },
    failed: { label: "오류", icon: "×" },
    interrupted: { label: "중단됨", icon: "■" },
    completed: { label: "완료", icon: "✓" },
    cancelled: { label: "취소됨", icon: "−" },
    idle: { label: "대기", icon: "○" },
};

export type WorkspaceGroup = { id: string | null; name: string; items: SidebarSession[] };

/// 프로젝트 모드의 사이드바 묶음: 프로젝트 폴더(기본 워크스페이스) → 워크스페이스 순서. 대화가 없는 워크스페이스도 보인다.
/// 쓸 수 없는 워크스페이스(경로 없음·제거)에 남은 대화는 숨기지 않고 따로 묶는다.
export function groupByWorkspace(items: SidebarSession[], spaces: { id: string; name: string }[]): WorkspaceGroup[] {
    const groups: WorkspaceGroup[] = [{ id: null, name: "프로젝트 폴더", items: [] }, ...spaces.map((w) => ({ id: w.id, name: w.name, items: [] }))];
    for (const item of items) {
        const id = item.session.worktree_id;
        let group = groups.find((g) => g.id === id);
        if (!group) {
            group = { id, name: "경로 없는 워크스페이스", items: [] };
            groups.push(group);
        }
        group.items.push(item);
    }
    return groups;
}

export function projectStatus(statuses: Record<string, number>): string {
    return Object.keys(STATUS).find((status) => (statuses[status] ?? 0) > 0)
        ?? (Object.values(statuses).some((count) => count > 0) ? "unknown" : "idle");
}

export async function pinSession(item: Pick<SidebarSession, "session" | "recent_id" | "recent_revision">, pinned: boolean): Promise<void> {
    try {
        // 아직 열지 않은 세션만 최근 항목을 만든다. 기존 핀 변경은 접근·읽음·숨김을 건드리지 않는다.
        const recent = item.recent_id === null
            ? await api.post<RecentItem>("/recent/touch", {
                kind: "session", project_id: item.session.project_id, resource_id: item.session.id, reopen: false,
            })
            : { id: item.recent_id, revision: item.recent_revision! };
        try {
            await api.patch(`/recent/${recent.id}`, { expected_revision: recent.revision, pinned });
        } catch (error) {
            const current = error instanceof ApiError && error.code === "revision_conflict"
                ? (error.details as { current?: RecentItem } | undefined)?.current : undefined;
            if (!current) throw error;
            const pending = retryIntent(current, { pinned });
            if (pending) await api.patch(`/recent/${recent.id}`, pending);
        }
    } finally {
        // 응답이 유실돼도 서버 값을 다시 읽는다. 실패를 낙관적 성공으로 표시하지 않는다.
        invalidate("recent");
        invalidate(`sessions:${item.session.project_id}:history`);
        invalidate(`search:${item.session.project_id}:history`);
    }
}

export async function markSessionRead(item: SidebarSession): Promise<void> {
    try {
        await api.post("/recent/touch", {
            kind: "session", project_id: item.session.project_id, resource_id: item.session.id,
            reopen: false,
            view_state: { last_seen_seq: item.session.last_message_seq },
        });
    } finally {
        invalidate("recent");
    }
}
