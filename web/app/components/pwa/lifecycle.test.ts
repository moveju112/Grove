import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
    values = new Map<string, string>();
    fail: string | null = null;
    failKey = "";
    get length() { return this.values.size; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) {
        if (this.fail && key.startsWith(this.failKey)) throw new DOMException("storage denied", this.fail);
        this.values.set(key, value);
    }
    removeItem(key: string) { this.values.delete(key); }
    clear() { this.values.clear(); }
}

let lifecycle: typeof import("./lifecycle");
let local: MemoryStorage;
let browser: { onLine: boolean; storage?: { persisted: () => Promise<boolean> } };
beforeEach(async () => {
    vi.resetModules();
    local = new MemoryStorage();
    browser = { onLine: true, storage: { persisted: async () => false } };
    vi.stubGlobal("navigator", browser);
    vi.stubGlobal("window", { localStorage: local });
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    lifecycle = await import("./lifecycle");
});
afterEach(() => { vi.unstubAllGlobals(); });

const health = (protocol: number, version = "any-server-build") => new Response(JSON.stringify({ protocol, version }));

describe("서버 작업 경계", () => {
    it("protocol이 같은 서로 다른 빌드는 허용하고, 호환 확인 전에는 전송하지 않는다", async () => {
        expect(() => lifecycle.requireServerAction()).toThrow("호환성을 확인");
        vi.stubGlobal("fetch", vi.fn(async () => health(1, "different-build")));
        await lifecycle.checkCompatibility();
        expect(lifecycle.serverBlockReason(lifecycle.lifecycleSnapshot())).toBeNull();
        expect(() => lifecycle.requireServerAction()).not.toThrow();
    });

    it("health에서 protocol 불일치를 미리 감지하고 기존 API 경계도 변경 요청을 보내지 않는다", async () => {
        const fetch = vi.fn(async () => health(2));
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        expect(lifecycle.serverBlockReason(lifecycle.lifecycleSnapshot())).toContain("protocol 2");
        const { api } = await import("../../api/client");
        await expect(api.post("/projects", {})).rejects.toMatchObject({ code: "protocol_mismatch" });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]).toEqual(["/api/v1/health", expect.objectContaining({ cache: "no-store" })]);
    });

    it("오프라인은 조회도 보내지 않고 복구 후 호환 조회만 한다. 변경 요청을 자동 재전송하지 않는다", async () => {
        const fetch = vi.fn(async () => health(1));
        vi.stubGlobal("fetch", fetch);
        browser.onLine = false;
        await lifecycle.checkCompatibility();
        expect(fetch).not.toHaveBeenCalled();
        expect(() => lifecycle.requireServerAction()).toThrow("오프라인에서는 초안만");
        browser.onLine = true;
        expect(() => lifecycle.requireServerAction()).toThrow("오프라인에서는 초안만");
        await lifecycle.checkCompatibility();
        expect(() => lifecycle.requireServerAction()).not.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("다른 화면의 변경 요청도 오프라인에서 fetch 전에 거부하며 결과 불명으로 표시하지 않는다", async () => {
        const fetch = vi.fn(async () => health(1));
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        browser.onLine = false;
        const { api } = await import("../../api/client");
        for (const operation of [
            () => api.post("/tool-calls/fixture/decision", { decision: "approve" }),
            () => api.put("/settings", {}),
            () => api.patch("/sessions/fixture", {}),
            () => api.del("/projects/fixture"),
        ]) {
            await expect(operation()).rejects.toMatchObject({
                code: "offline", retryable: false, details: { result_unknown: false },
            });
        }
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        () => Promise.reject(new TypeError("network lost")),
        async () => new Response("{}"),
        async () => new Response('{"protocol":1}', { status: 503 }),
    ])("서버 연결·호환 조회 실패를 전송 가능으로 표시하지 않는다", async (reply) => {
        vi.stubGlobal("fetch", vi.fn(reply));
        await lifecycle.checkCompatibility();
        expect(lifecycle.lifecycleSnapshot().connection).toBe("unreachable");
        expect(() => lifecycle.requireServerAction()).toThrow("서버에 연결할 수 없어");
    });
});

describe("초안 저장소", () => {
    it("실제 초안 쓰기의 quota 초과를 구분하고 기존 초안을 지우거나 오류를 삼키지 않는다", () => {
        const storage = lifecycle.localDraftStorage()!;
        storage.setItem("grove.draft.fixture", "existing draft");
        local.failKey = "grove.draft.";
        local.fail = "QuotaExceededError";
        expect(() => storage.setItem("grove.draft.fixture", "new input")).toThrow();
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBe("quota");
        expect(local.getItem("grove.draft.fixture")).toBe("existing draft");
        local.fail = null;
        lifecycle.inspectLocalDrafts();
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBe("quota");
        storage.setItem("grove.draft.fixture", "new input");
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBeNull();
    });

    it("Storage 접근 거부와 quota 초과를 구분한다", () => {
        vi.stubGlobal("window", { get localStorage() { throw new DOMException("denied", "SecurityError"); } });
        expect(lifecycle.localDraftStorage()).toBeNull();
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBe("unavailable");
        expect(lifecycle.storageFailure(new DOMException("", "NS_ERROR_DOM_QUOTA_REACHED"))).toBe("quota");
    });

    it("첫 방문을 eviction으로 오인하지 않으며, 관측한 저장 데이터 유실은 경고한다", () => {
        lifecycle.inspectLocalDrafts();
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBeNull();
        local.clear();
        lifecycle.inspectLocalDrafts();
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBe("missing");
        expect(local.getItem("grove.draft.fixture")).toBeNull();
    });

    it("navigator.storage 미지원이어도 localStorage 초안을 막지 않는다", async () => {
        delete browser.storage;
        await lifecycle.inspectStoragePolicy();
        expect(lifecycle.lifecycleSnapshot().storageApi).toBe("unsupported");
        lifecycle.localDraftStorage()!.setItem("grove.draft.fixture", "offline draft");
        expect(local.getItem("grove.draft.fixture")).toBe("offline draft");
        expect(lifecycle.lifecycleSnapshot().storageIssue).toBeNull();
    });

    it("정책 조회 거부·best-effort·영구 보관을 구분한다", async () => {
        await lifecycle.inspectStoragePolicy();
        expect(lifecycle.lifecycleSnapshot().persistence).toBe("best-effort");
        browser.storage = { persisted: async () => true };
        await lifecycle.inspectStoragePolicy();
        expect(lifecycle.lifecycleSnapshot().persistence).toBe("persistent");
        browser.storage = { persisted: async () => { throw new DOMException("", "SecurityError"); } };
        await lifecycle.inspectStoragePolicy();
        expect(lifecycle.lifecycleSnapshot().storageApi).toBe("unavailable");
        expect(lifecycle.lifecycleSnapshot().persistence).toBe("unknown");
    });
});
