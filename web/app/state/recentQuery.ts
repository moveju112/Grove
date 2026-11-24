import { api } from "../api/client";
import type { RecentPage } from "../api/generated";
import { recentSince, type RecentWindow } from "./recentWindow";

export const RECENT_PAGE_SIZE = 30;
export const recentRangeKey = (range: RecentWindow, limit: number) => `recent:range:${range}:${limit}`;

// 더 보기는 표시 중인 페이지의 다음 위치부터, 재검증은 같은 기간의 첫 항목부터 읽는다.
export async function readRecentRange(range: RecentWindow, limit: number, previous?: RecentPage): Promise<RecentPage> {
    const since = recentSince(range, new Date());
    let offset = previous?.next_offset ?? 0;
    const items = new Map(previous?.items.map((item) => [item.id, item]));
    for (;;) {
        const q = new URLSearchParams({ filter: "all", limit: String(Math.min(200, Math.max(1, limit - offset))), since });
        if (offset) q.set("offset", String(offset));
        const page = await api.get<RecentPage>(`/recent?${q}`, { timeoutMs: 10_000 });
        for (const item of page.items) items.set(item.id, item);
        const next = page.next_offset;
        if (next == null || next <= offset || next >= limit) return { ...page, items: [...items.values()], next_offset: next != null && next <= offset ? null : next };
        offset = next;
    }
}
