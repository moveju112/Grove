import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStream, type StreamHandlers } from "./events";

afterEach(() => vi.unstubAllGlobals());
const hello = new TextEncoder().encode('event: hello\ndata: {"cursor":0,"capabilities":[]}\n\n');
const handlers = (onStatus: StreamHandlers["onStatus"], onPartial: StreamHandlers["onPartial"] = vi.fn()): StreamHandlers => ({
    onStatus, onPartial, onEvents: vi.fn(), onResync: vi.fn(),
});

describe("화면 복귀", () => {
    it("최근 SSE 데이터는 유지하고, 오래 멈춘 직접 연결은 마지막 cursor로 즉시 복구한다", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
        vi.stubGlobal("document", doc);
        vi.stubGlobal("window", new EventTarget());
        const change = (visibilityState: string) => {
            doc.visibilityState = visibilityState;
            doc.dispatchEvent(new Event("visibilitychange"));
        };
        const fetcher = vi.fn((_url: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(hello);
                init.signal!.addEventListener("abort", () => c.error(new DOMException("fixture abort", "AbortError")), { once: true });
            },
        }))));
        vi.stubGlobal("fetch", fetcher);
        const h = handlers(vi.fn());
        const stream = new EventStream(h);
        try {
            stream.start(10);
            await vi.waitFor(() => expect(h.onResync).toHaveBeenCalledExactlyOnceWith("subscription"));
            change("hidden");
            change("visible");
            await Promise.resolve();
            expect(fetcher).toHaveBeenCalledTimes(1);
            change("hidden");
            vi.setSystemTime(Date.now() + 20_000);
            change("visible");
            await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
            expect(fetcher.mock.calls[1]?.[0]).toContain("cursor=10");
        } finally { stream.stop(); vi.useRealTimers(); }
    });

    it.each([false, true])("복귀 이벤트가 겹쳐도 직접 연결을 한 번만 검사한다 (keep-alive=%s)", async (heartbeat) => {
        const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
        const win = new EventTarget();
        vi.stubGlobal("document", doc);
        vi.stubGlobal("window", win);
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const fetcher = vi.fn((_url: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            start(c) {
                body = c;
                c.enqueue(hello);
                init.signal!.addEventListener("abort", () => c.error(new DOMException("fixture abort", "AbortError")), { once: true });
            },
        }))));
        vi.stubGlobal("fetch", fetcher);
        let live!: () => void;
        const ready = new Promise<void>((resolve) => { live = resolve; });
        const h = handlers((status) => { if (status === "live") live(); });
        const stream = new EventStream(h);
        vi.useFakeTimers();
        try {
            stream.start(10);
            await ready;
            doc.visibilityState = "hidden";
            doc.dispatchEvent(new Event("visibilitychange"));
            await vi.advanceTimersByTimeAsync(10_000);
            doc.visibilityState = "visible";
            doc.dispatchEvent(new Event("visibilitychange"));
            win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
            win.dispatchEvent(new Event("online"));
            await vi.advanceTimersByTimeAsync(2_000);
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(1);
            if (heartbeat) body.enqueue(new TextEncoder().encode(": hb\n\n"));
            await vi.advanceTimersByTimeAsync(6_000);
            expect(fetcher).toHaveBeenCalledTimes(heartbeat ? 1 : 2);
            if (!heartbeat) {
                expect(fetcher.mock.calls[1]?.[0]).toContain("cursor=10");
                expect(h.onResync).toHaveBeenLastCalledWith("reconnect");
            }
        } finally { stream.stop(); vi.useRealTimers(); }
    });

    it("네트워크 상태 변화 없이 화면이 켜지면 backoff를 바로 건너뛴다", async () => {
        const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
        vi.stubGlobal("document", doc);
        const fetcher = vi.fn().mockRejectedValue(new TypeError("not connected"));
        vi.stubGlobal("fetch", fetcher);
        let offline!: () => void;
        const waiting = new Promise<void>((resolve) => { offline = resolve; });
        const stream = new EventStream(handlers((status) => { if (status === "offline") offline(); }));
        try {
            stream.start(null);
            await waiting;
            doc.visibilityState = "visible";
            doc.dispatchEvent(new Event("visibilitychange"));
            await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 200 });
        } finally { stream.stop(); }
    });
});

describe("대화 상세 stream 소유권", () => {
    it("만료된 access와 일시적인 갱신 오류가 겹쳐도 인증 종료 대신 backoff 후 연결을 복구한다", async () => {
        const client = await import("./client");
        let blocked = true;
        let refreshed = 0;
        const statuses: string[] = [];
        let live!: () => void, failed!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => { live = resolve; failed = reject; });
        vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
            if (url.endsWith("/pairing/claim")) return Promise.resolve(new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" })));
            if (url.endsWith("/auth/logout")) return Promise.resolve(new Response("{}"));
            if (url.endsWith("/auth/refresh")) {
                refreshed++;
                return Promise.resolve(new Response("{}", { status: 503 }));
            }
            if (blocked) return Promise.resolve(new Response("{}", { status: 401 }));
            return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(hello);
                    init.signal!.addEventListener("abort", () => c.error(new DOMException("fixture abort", "AbortError")), { once: true });
                },
            })));
        }));
        await client.redeemPairing("fixture-pairing");
        const stream = new EventStream(handlers((status) => {
            statuses.push(status);
            if (status === "auth_expired") failed(new Error("일시 오류가 인증을 종료함"));
            if (status === "offline") {
                blocked = false;
                queueMicrotask(() => stream.retryNow());
            }
            if (status === "live") live();
        }));
        try {
            stream.start(null);
            await ready;
            expect(client.isLoggedIn()).toBe(true);
            expect(statuses).toContain("offline");
            expect(statuses).not.toContain("auth_expired");
            expect(refreshed).toBe(2);
        } finally {
            stream.stop();
            await client.logout();
        }
    });

    it("cursor 재연결에서 삭제 신호를 놓쳤어도 최신 partial을 받기 전에 이전 임시 응답을 비운다", async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let first!: () => void, second!: () => void, received!: () => void;
        const firstLive = new Promise<void>((resolve) => { first = resolve; });
        const secondLive = new Promise<void>((resolve) => { second = resolve; });
        let partialReceived = new Promise<void>((resolve) => { received = resolve; });
        const urls: string[] = [];
        let live = 0;
        let snapshots: Record<string, unknown> = {};
        const order: string[] = [];
        const onResync = vi.fn(() => { snapshots = {}; order.push("reset"); });
        vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
            urls.push(url);
            return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                start(c) {
                    controller = c;
                    c.enqueue(new TextEncoder().encode('event: hello\ndata: {"cursor":10,"capabilities":[]}\n\n'));
                    init.signal!.addEventListener("abort", () => c.error(new DOMException("fixture abort", "AbortError")), { once: true });
                },
            }), { headers: { "content-type": "text/event-stream" } }));
        }));
        const stream = new EventStream({
            ...handlers((status) => {
                if (status === "live") { live++; if (live === 1) first(); else if (live === 2) second(); }
                if (status === "offline") queueMicrotask(() => stream.retryNow());
            }, (sid, snapshot) => { snapshots[sid] = snapshot; order.push("partial"); received(); }),
            onResync,
        });
        stream.setSessions(["s"]);
        stream.start(null);
        try {
            await firstLive;
            controller.enqueue(new TextEncoder().encode('event: partial\ndata: {"session_id":"s","snapshot":{"turn_id":"previous","text":"이전 진행 설명"}}\n\n'));
            await partialReceived;
            expect(snapshots.s).toEqual({ turn_id: "previous", text: "이전 진행 설명" });
            partialReceived = new Promise<void>((resolve) => { received = resolve; });
            // 서버에서는 이 사이 완료되었고, 비영속 partial:null은 연결 밖으로 유실된다.
            controller.error(new TypeError("fixture connection lost"));
            await secondLive;
            expect(new URL(urls[1]!, "http://fixture").searchParams.get("cursor")).toBe("10");
            expect(onResync.mock.calls).toEqual([["initial"], ["reconnect"]]);
            expect(snapshots).toEqual({});
            controller.enqueue(new TextEncoder().encode('event: partial\ndata: {"session_id":"s","snapshot":{"turn_id":"next","text":"다음 응답"}}\n\n'));
            await partialReceived;
            expect(snapshots.s).toEqual({ turn_id: "next", text: "다음 응답" });
            expect(order).toEqual(["reset", "partial", "reset", "partial"]);
        } finally { stream.stop(); }
    });

    it("잘못된 frame으로 재연결 대기에 들어갈 때도 이전 reader를 해제한다", async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let ready!: () => void, waiting!: () => void;
        let cancelled = false;
        const live = new Promise<void>((resolve) => { ready = resolve; });
        const offline = new Promise<void>((resolve) => { waiting = resolve; });
        const body = new ReadableStream<Uint8Array>({
            start(c) { controller = c; c.enqueue(hello); },
            cancel() { cancelled = true; },
        });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })));
        const stream = new EventStream(handlers((status) => {
            if (status === "live") ready();
            if (status === "offline") waiting();
        }));
        stream.start(null);
        try {
            await live;
            controller.enqueue(new TextEncoder().encode("event: event\ndata: {invalid\n\n"));
            await offline;
            expect(cancelled).toBe(true);
        } finally {
            stream.stop();
            if (!cancelled) controller.close();
        }
    });
    it("resync 뒤 같은 chunk의 이전 frame을 버리고 기존 reader를 닫은 뒤 snapshot 연결로 바꾼다", async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let first!: () => void, second!: () => void;
        const firstLive = new Promise<void>((resolve) => { first = resolve; });
        const secondLive = new Promise<void>((resolve) => { second = resolve; });
        let calls = 0, live = 0, cancelled = false;
        vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
            calls++;
            const initial = calls === 1;
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    if (initial) controller = c;
                    c.enqueue(hello);
                    init.signal!.addEventListener("abort", () => { if (!initial || !cancelled) c.error(new DOMException("fixture abort", "AbortError")); }, { once: true });
                },
                cancel() { if (initial) cancelled = true; },
            });
            return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
        }));
        const partial = vi.fn();
        const stream = new EventStream(handlers((status) => {
            if (status === "live") { live++; if (live === 1) first(); else if (live === 2) second(); }
        }, partial));
        stream.setSessions(["first"]);
        stream.start(null);
        try {
            await firstLive;
            controller.enqueue(new TextEncoder().encode('event: resync\ndata: {}\n\nevent: partial\ndata: {"session_id":"first","snapshot":{"text":"stale fixture"}}\n\n'));
            await secondLive;
            expect(cancelled).toBe(true);
            expect(calls).toBe(2);
            expect(partial).not.toHaveBeenCalled();
        } finally { stream.stop(); }
    });
    it("같은 대화의 사본 추가·제거는 연결을 늘리지 않고 실제 구독 집합이 바뀔 때만 다시 연결한다", async () => {
        const signals: AbortSignal[] = [];
        const urls: string[] = [];
        let first!: () => void, second!: () => void;
        const firstLive = new Promise<void>((resolve) => { first = resolve; });
        const secondLive = new Promise<void>((resolve) => { second = resolve; });
        let live = 0;
        vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
            urls.push(url);
            signals.push(init.signal!);
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(hello);
                    init.signal!.addEventListener("abort", () => c.error(new DOMException("fixture abort", "AbortError")), { once: true });
                },
            });
            return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
        }));
        const stream = new EventStream(handlers((status) => {
            if (status === "live") { live++; if (live === 1) first(); else if (live === 2) second(); }
        }));
        stream.setSessions(["second", "first", "first"]);
        stream.start(null);
        try {
            await firstLive;
            expect(new URL(urls[0]!, "http://fixture").searchParams.get("sessions")).toBe("first,second");
            stream.setSessions(["first", "second"]);
            expect(signals[0]!.aborted).toBe(false);
            expect(urls).toHaveLength(1);
            stream.setSessions(["second", "second"]);
            await secondLive;
            expect(signals[0]!.aborted).toBe(true);
            expect(signals[1]!.aborted).toBe(false);
            expect(urls).toHaveLength(2);
            expect(new URL(urls[1]!, "http://fixture").searchParams.get("sessions")).toBe("second");
        } finally { stream.stop(); }
        expect(signals[1]!.aborted).toBe(true);
    });

    it("중지 뒤 이미 도착한 늦은 frame도 전달하지 않고 reader를 해제한다", async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let ready!: () => void, cancel!: () => void, delivered!: () => void;
        let closed = false;
        const live = new Promise<void>((resolve) => { ready = resolve; });
        const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
        const partial = new Promise<void>((resolve) => { delivered = resolve; });
        const onPartial = vi.fn(() => delivered());
        // fetch의 중지 전에 버퍼에 들어온 frame을 재현한다. signal만으로 전달 차단을 가정하지 않는다.
        const body = new ReadableStream<Uint8Array>({
            start(c) { controller = c; c.enqueue(hello); },
            cancel() { closed = true; cancel(); },
        });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })));
        const stream = new EventStream(handlers((status) => { if (status === "live") ready(); }, onPartial));
        stream.setSessions(["first"]);
        stream.start(null);
        try {
            await live;
            stream.stop();
            controller.enqueue(new TextEncoder().encode('event: partial\ndata: {"session_id":"first","snapshot":{"text":"late fixture"}}\n\n'));
            expect(await Promise.race([cancelled.then(() => "cancelled"), partial.then(() => "delivered")])).toBe("cancelled");
            expect(onPartial).not.toHaveBeenCalled();
        } finally {
            stream.stop();
            if (!closed) controller.error(new Error("fixture cleanup"));
        }
    });
});
