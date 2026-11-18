import { afterEach, expect, it, vi } from "vitest";
import { applyEvent, clearServerCache, resyncAll, subscribeQuery } from "../../state/store";

afterEach(clearServerCache);

it.each([
    "message.created", "turn.updated", "tool_call.updated", "session.created",
    "session.updated", "session.rewound", "session.deleted", "recent.updated", "project.updated",
])("%s는 열린 사이드바의 상태·읽음·핀 집계를 갱신한다", async (kind) => {
    const fetcher = vi.fn(async () => ({}));
    const off = subscribeQuery("recent:sidebar:p:offset=0", fetcher, () => undefined);
    try {
        expect(fetcher).toHaveBeenCalledTimes(1);
        applyEvent({
            seq: 1, created_at: "2026-01-01T00:00:00Z", kind, project_id: "p", session_id: "s",
            payload: { id: "s", status: "completed", name: "write" },
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    } finally { off(); }
});

it("재연결 뒤 재동기화는 사이드바를 새로 읽고 닫힌 구독은 읽지 않는다", async () => {
    const fetcher = vi.fn(async () => ({}));
    const off = subscribeQuery("recent:sidebar:p:offset=0", fetcher, () => undefined);
    resyncAll();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    off();
    resyncAll();
    expect(fetcher).toHaveBeenCalledTimes(2);
});
