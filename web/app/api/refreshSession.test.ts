import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function storage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", storage());
    vi.stubGlobal("navigator", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("브라우저 갱신 요청 수명", () => {
    it("응답이 없는 요청은 모듈 재시작 뒤에도 같은 키를 쓰고 성공한 요청만 지운다", async () => {
        const first = await import("./refreshSession");
        const key = first.refreshRequestKey();
        vi.resetModules();
        const second = await import("./refreshSession");
        expect(second.refreshRequestKey()).toBe(key);
        second.clearRefreshRequestKey("another-request");
        expect(second.pendingRefreshKey()).toBe(key);
        second.clearRefreshRequestKey(key);
        expect(second.pendingRefreshKey()).toBeNull();
        expect(second.refreshRequestKey()).not.toBe(key);
    });

    it("서버·pin이 달라지면 요청 키를 공유하지 않는다", async () => {
        const session = await import("./refreshSession");
        const direct = session.refreshRequestKey();
        const { configureConnection } = await import("./transport");
        configureConnection({ endpoint: "wss://fixture.test/api/e2ee", key: btoa("a".repeat(32)) });
        const first = session.refreshRequestKey();
        expect(first).not.toBe(direct);
        configureConnection({ endpoint: "wss://fixture.test/api/e2ee", key: btoa("b".repeat(32)) });
        expect(session.refreshRequestKey()).not.toBe(first);
    });

    it("서로 다른 탭의 갱신도 동일한 Web Lock 안에서 실행한다", async () => {
        let tail = Promise.resolve();
        const names: string[] = [];
        vi.stubGlobal("navigator", { locks: {
            request: (name: string, run: () => Promise<void>) => {
                names.push(name);
                const task = tail.then(run);
                tail = task;
                return task;
            },
        } });
        const first = await import("./refreshSession");
        vi.resetModules();
        const second = await import("./refreshSession");
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const events: string[] = [];
        const a = first.withRefreshLock(async () => { events.push("first"); await pending; events.push("done"); });
        const b = second.withRefreshLock(async () => { events.push("second"); });
        await Promise.resolve();
        expect(events).toEqual(["first"]);
        release();
        await Promise.all([a, b]);
        expect(events).toEqual(["first", "done", "second"]);
        expect(names[0]).toBe(names[1]);
    });
});
