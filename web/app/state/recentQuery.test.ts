import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { RecentItem } from "../api/generated";
import { readRecentRange } from "./recentQuery";

const item = (id: number): RecentItem => ({
    id: String(id), kind: "session", project_id: "p", project_name: "", resource_id: String(id), title: "",
    last_access_at: "", pinned: false, hidden: false, view_state: null, revision: 0, status: "active",
    unread: false, completed_turn_id: null, completion_unread: false, last_user_message_at: null, last_activity_at: "",
});
afterEach(() => vi.restoreAllMocks());

it("200개를 넘는 목록을 서버 페이지 한도에 맞춰 읽는다", async () => {
    const get = vi.spyOn(api, "get")
        .mockResolvedValueOnce({ items: Array.from({ length: 200 }, (_, i) => item(i)), next_offset: 200, total: 240 })
        .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => item(200 + i)), next_offset: 210, total: 240 });
    const result = await readRecentRange("4h", 210);
    expect(result.items).toHaveLength(210);
    expect(result.next_offset).toBe(210);
    const params = get.mock.calls.map(([path]) => new URL(path, "http://test").searchParams);
    expect(params.map((p) => [p.get("limit"), p.get("offset")])).toEqual([["200", null], ["10", "200"]]);
});

it("더 보기는 표시 중인 끝에서 시작하고 경계에 겹친 항목을 한 번만 표시한다", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValueOnce({ items: [item(1), item(2)], next_offset: null, total: 3 });
    const result = await readRecentRange("4h", 32, { items: [item(0), item(1)], next_offset: 2, total: 3 });
    expect(result.items.map((i) => i.id)).toEqual(["0", "1", "2"]);
    expect(get.mock.calls).toHaveLength(1);
    expect(get.mock.calls[0]![0]).toContain("offset=2");
});
