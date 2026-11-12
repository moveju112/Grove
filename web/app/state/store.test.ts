import { describe, expect, it, vi } from "vitest";
import { cacheStats, IDLE_ENTRY_LIMIT, invalidate, subscribeQuery } from "./store";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("중복 viewer의 조회 구독(PANE-007)", () => {
    it("같은 대화를 여러 pane에서 보면 한 번 읽고 무효화도 한 번만 다시 읽는다", async () => {
        const fetcher = vi.fn(async () => "data");
        const a = vi.fn();
        const b = vi.fn();
        const offA = subscribeQuery("messages:dup", fetcher, a);
        const offB = subscribeQuery("messages:dup", fetcher, b);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        invalidate("messages:dup");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(a).toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
        // 한 viewer를 닫아도 남은 viewer는 계속 갱신된다.
        offA();
        b.mockClear();
        invalidate("messages:dup");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(b).toHaveBeenCalled();
        offB();
    });
    it("마지막 viewer를 닫으면 다시 읽지 않고, 다시 열 때 한 번만 최신 값을 읽는다", async () => {
        const fetcher = vi.fn(async () => fetcher.mock.calls.length);
        const off = subscribeQuery("messages:closed", fetcher, () => undefined);
        await settle();
        off();
        invalidate("messages:closed");
        invalidate("messages:closed");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        const again = subscribeQuery("messages:closed", fetcher, () => undefined);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        again();
        // 무효화가 없었으면 다시 열어도 cache를 그대로 쓴다.
        const third = subscribeQuery("messages:closed", fetcher, () => undefined);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        third();
    });
    it("구독자가 없는 항목은 상한까지만 보관하고 보고 있는 항목은 버리지 않는다", async () => {
        const kept = subscribeQuery("messages:kept", async () => "x", () => undefined);
        for (let i = 0; i < IDLE_ENTRY_LIMIT + 50; i++) subscribeQuery(`messages:idle-${i}`, async () => i, () => undefined)();
        await settle();
        const stats = cacheStats();
        expect(stats.entries).toBeLessThanOrEqual(IDLE_ENTRY_LIMIT + stats.subscribed);
        expect(stats.subscribed).toBeGreaterThanOrEqual(1);
        const fetcher = vi.fn(async () => "y");
        const again = subscribeQuery("messages:kept", fetcher, () => undefined);
        await settle();
        expect(fetcher).not.toHaveBeenCalled();
        again();
        kept();
    });
});
