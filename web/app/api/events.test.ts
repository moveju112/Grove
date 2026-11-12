import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStream, type StreamHandlers } from "./events";

afterEach(() => vi.unstubAllGlobals());
const hello = new TextEncoder().encode('event: hello\ndata: {"cursor":0,"capabilities":[]}\n\n');
const handlers = (onStatus: StreamHandlers["onStatus"], onPartial = vi.fn()): StreamHandlers => ({
    onStatus, onPartial, onEvent: vi.fn(), onResync: vi.fn(),
});

describe("대화 상세 stream 소유권", () => {
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
