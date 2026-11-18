// 최근 항목 시간 범위(RECENT-001). 원본 최근 탭의 범위 선택·기본값을 따른다.
// 대화의 범위는 마지막 확정 답변(없으면 생성 시각) 기준이다. 고정·실행 중·승인/답변 대기는 서버가 범위 밖에서도 남긴다.
export const RECENT_WINDOW_OPTIONS = ["15m", "30m", "1h", "2h", "4h", "8h", "12h", "24h", "today"] as const;
export type RecentWindow = (typeof RECENT_WINDOW_OPTIONS)[number];
export const DEFAULT_RECENT_WINDOWS: readonly RecentWindow[] = ["30m", "4h", "12h"];
export const DEFAULT_RECENT_WINDOW: RecentWindow = "4h";
export const MAX_RECENT_WINDOWS = 3;

const MINUTES: Record<Exclude<RecentWindow, "today">, number> = { "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "8h": 480, "12h": 720, "24h": 1440 };

export function isRecentWindow(v: unknown): v is RecentWindow {
    return RECENT_WINDOW_OPTIONS.includes(v as RecentWindow);
}

/// 선택지 순서·중복 제거·최대 3개, 비면 기본값.
export function normalizeRecentWindows(windows: readonly unknown[]): RecentWindow[] {
    const picked = RECENT_WINDOW_OPTIONS.filter((o) => windows.includes(o)).slice(0, MAX_RECENT_WINDOWS);
    return picked.length > 0 ? picked : [...DEFAULT_RECENT_WINDOWS];
}

/// 고른 범위가 목록에서 빠졌으면 그보다 넓은 첫 범위, 없으면 가장 넓은 범위를 쓴다.
export function effectiveRecentWindow(selected: RecentWindow, windows: readonly RecentWindow[]): RecentWindow {
    if (windows.includes(selected)) return selected;
    const rank = RECENT_WINDOW_OPTIONS.indexOf(selected);
    return windows.find((o) => RECENT_WINDOW_OPTIONS.indexOf(o) >= rank) ?? windows[windows.length - 1]!;
}

/// 범위 하한. 같은 분 안에서는 같은 값이 되도록 분 단위로 내린다(조회 key 안정).
export function recentSince(window: RecentWindow, now: Date): string {
    const at = window === "today"
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        : Math.floor(now.getTime() / 60_000) * 60_000 - MINUTES[window] * 60_000;
    return new Date(at).toISOString();
}

export function recentWindowLabel(window: RecentWindow): string {
    if (window === "today") return "오늘";
    const m = MINUTES[window];
    return m < 60 ? `${m}분` : `${m / 60}시간`;
}

/// 분할로 함께 연 대화 묶음: 목록 순서를 유지하되 묶음의 나머지는 가장 앞선(최근) 항목 바로 아래로 모은다.
export function groupBySplit<T extends { kind: string; resource_id: string }>(items: readonly T[], linked: ReadonlySet<string>): { item: T; linked: T[] }[] {
    const isLinked = (it: T) => it.kind === "session" && linked.has(it.resource_id);
    const members = items.filter(isLinked);
    const out: { item: T; linked: T[] }[] = [];
    for (const it of items) {
        if (members.length > 1 && isLinked(it)) {
            if (it === members[0]) out.push({ item: it, linked: members.slice(1) });
            continue;
        }
        out.push({ item: it, linked: [] });
    }
    return out;
}
