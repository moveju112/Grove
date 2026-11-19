import { ApiError, api, newKey } from "../api/client";
import type { RecentItem } from "../api/generated";

// 최근 항목 고정·숨김의 기기 간 동시 변경(RECENT-006).
// 사용자가 누른 의도(바꾸려는 필드와 값)만 보내므로, 충돌하면 최신 항목에서 이미 그 값이면 그대로 두고
// 아니면 최신 revision으로 그 필드만 한 번 다시 적용한다. 다른 기기가 바꾼 다른 필드는 덮어쓰지 않는다.
export type RecentIntent = { pinned?: boolean; hidden?: boolean };
type Current = { pinned: boolean; hidden: boolean; revision: number };

export function retryIntent(current: Current, intent: RecentIntent): ({ expected_revision: number } & RecentIntent) | null {
    const pending = (Object.keys(intent) as (keyof RecentIntent)[]).filter((k) => intent[k] !== undefined && current[k] !== intent[k]);
    if (pending.length === 0) return null;
    return { expected_revision: current.revision, ...Object.fromEntries(pending.map((k) => [k, intent[k]])) };
}

export function prepareRecentPatch(item: Pick<RecentItem, "id" | "revision">, intent: RecentIntent): () => Promise<void> {
    let body = { expected_revision: item.revision, ...intent };
    let key = newKey();
    let rebased = false;
    return async () => {
        for (;;) {
            try {
                await api.patch(`/recent/${item.id}`, body, { key });
                return;
            } catch (error) {
                const current = !rebased && error instanceof ApiError && error.code === "revision_conflict"
                    ? (error.details as { current?: RecentItem } | undefined)?.current : undefined;
                if (!current) throw error;
                const again = retryIntent(current, intent);
                if (!again) return;
                // 충돌로 본문을 바꿀 때만 새 키를 쓴다. 응답을 잃으면 마지막 본문과 키 그대로 확인한다.
                body = again;
                key = newKey();
                rebased = true;
            }
        }
    };
}

export async function patchRecent(item: RecentItem, intent: RecentIntent): Promise<void> {
    await prepareRecentPatch(item, intent)();
}

export async function hideSessionRecent(projectId: string, sessionId: string): Promise<void> {
    const item = await api.post<RecentItem>("/recent/touch", {
        kind: "session", project_id: projectId, resource_id: sessionId, reopen: false,
    });
    await patchRecent(item, { hidden: true });
}
