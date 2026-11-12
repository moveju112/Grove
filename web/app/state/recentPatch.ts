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
