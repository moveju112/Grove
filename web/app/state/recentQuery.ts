import { api } from "../api/client";
import type { RecentPage } from "../api/generated";
import { recentSince, type RecentWindow } from "./recentWindow";

export const RECENT_PAGE_SIZE = 30;
export const recentRangeKey = (range: RecentWindow, limit: number) => `recent:range:${range}:${limit}`;

export function readRecentRange(range: RecentWindow, limit: number) {
    const q = new URLSearchParams({ filter: "all", limit: String(limit), since: recentSince(range, new Date()) });
    // 폰에서 잠들기 전에 시작한 요청이 새 목록을 오래 막지 않도록 목록 조회만 짧게 제한한다.
    return api.get<RecentPage>(`/recent?${q}`, { timeoutMs: 10_000 });
}
