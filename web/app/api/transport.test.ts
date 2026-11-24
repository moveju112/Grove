import { afterEach, describe, expect, it, vi } from "vitest";
import { Cipher, Mux, base64, connectionLink, parseConnectionLink, transportFetch, validateConnection } from "./transport";

afterEach(() => vi.unstubAllGlobals());
const key = base64(new Uint8Array(32).fill(7));

function chunkedMux(onSend: (kind: number, id: number, payload: Uint8Array, reply: (kind: number, id: number, payload?: Uint8Array) => void) => void) {
    const queued: Uint8Array[] = [];
    let receive: ((bytes: Uint8Array) => void) | undefined;
    const reply = (kind: number, id: number, payload: Uint8Array = new Uint8Array()) => {
        const bytes = new Uint8Array(5 + payload.length);
        bytes[0] = kind;
        new DataView(bytes.buffer).setUint32(1, id);
        bytes.set(payload, 5);
        if (receive) { const resolve = receive; receive = undefined; resolve(bytes); } else queued.push(bytes);
    };
    const channel = {
        protocol: 1, requestBodyChunks: true, close: vi.fn(),
        receive: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<Uint8Array>((resolve) => { receive = resolve; }),
        send: async (bytes: Uint8Array) => onSend(bytes[0]!, new DataView(bytes.buffer).getUint32(1), bytes.slice(5), reply),
    };
    return Reflect.construct(Mux, [channel]) as Mux;
}

describe("E2EE connection", () => {
    it("returns an early HTTP authentication error without sending the body", async () => {
        const sent: number[] = [];
        const mux = chunkedMux((kind, id, _payload, reply) => {
            sent.push(kind);
            if (kind !== 0x05) return;
            reply(0x11, id, new TextEncoder().encode(JSON.stringify({ type: "headers", status: 401, headers: [] })));
            reply(0x12, id, new TextEncoder().encode('{"error":{"code":"unauthorized"}}'));
            reply(0x13, id);
        });
        try {
            const response = await mux.request({ kind: "http", body: "" }, "POST", undefined, new Uint8Array(1024 * 1024 + 1));
            expect(response.meta.status).toBe(401);
            expect(await new Response(response.body).json()).toEqual({ error: { code: "unauthorized" } });
            expect(sent.filter((kind) => kind !== 0x02)).toEqual([0x05]);
        } finally { mux.fail(new TypeError("test complete")); }
    });
    it("sends raw request body in acknowledged chunks before committing the request", async () => {
        const sent: number[] = [];
        const chunks: Uint8Array[] = [];
        const bytes = new Uint8Array(1024 * 1024 + 3).fill(7);
        const mux = chunkedMux((kind, id, payload, reply) => {
            sent.push(kind);
            if (kind === 0x05) { expect(JSON.parse(new TextDecoder().decode(payload)).body).toBe(""); reply(0x16, id); }
            if (kind === 0x06) { chunks.push(payload); reply(0x16, id); }
            if (kind === 0x07) {
                reply(0x11, id, new TextEncoder().encode(JSON.stringify({ type: "headers", status: 201, headers: [] })));
                reply(0x13, id);
            }
        });
        try {
            const response = await mux.request({ kind: "http", body: "" }, "POST", undefined, bytes);
            expect(response.meta.status).toBe(201);
            await new Response(response.body).text();
            expect(sent).toEqual([0x05, 0x06, 0x06, 0x07]);
            expect(chunks.map((chunk) => chunk.length)).toEqual([1024 * 1024, 3]);
            expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
        } finally { mux.fail(new TypeError("test complete")); }
    });
    it.each(["abort", "reject"])("stops sending a partial body after %s", async (action) => {
        const sent: number[] = [];
        let firstChunk!: () => void;
        const ready = new Promise<void>((resolve) => { firstChunk = resolve; });
        let rejectUpload!: () => void;
        const mux = chunkedMux((kind, id, _payload, reply) => {
            sent.push(kind);
            if (kind === 0x05) reply(0x16, id);
            if (kind === 0x06) { rejectUpload = () => reply(0x14, id); firstChunk(); }
        });
        const abort = new AbortController();
        try {
            const request = mux.request({ kind: "http", body: "" }, "POST", abort.signal, new Uint8Array(1024 * 1024 + 1));
            const failed = expect(request).rejects.toThrow();
            await ready;
            if (action === "abort") abort.abort(); else rejectUpload();
            await failed;
            expect(sent).toEqual([0x05, 0x06, 0x03]);
        } finally { mux.fail(new TypeError("test complete")); }
    });
    it("rejects a blocked WebSocket even when no close event follows the error", async () => {
        class BlockedSocket extends EventTarget {
            onerror: (() => void) | null = null;
            constructor() {
                super();
                queueMicrotask(() => {
                    this.onerror?.();
                    this.dispatchEvent(new Event("error"));
                });
            }
            close() {}
        }
        vi.stubGlobal("WebSocket", BlockedSocket);
        await expect(Mux.open({ endpoint: "ws://127.0.0.1/api/e2ee", key })).rejects.toThrow("암호화 연결");
    });
    it("preserves the relay room while keeping pairing credentials in the fragment", () => {
        const config = { endpoint: "wss://relay.example/api/e2ee/" + "a".repeat(64), key };
        expect(parseConnectionLink(connectionLink(config)).connection).toEqual(config);
        expect(() => validateConnection({ endpoint: config.endpoint + "/control", key })).toThrow();
    });
    it("uses a fragment for the pin and one-time code, never query parameters", () => {
        const config = { endpoint: "wss://daemon.example/api/e2ee", key };
        const code = "12345678-1234-1234-1234-123456789012." + "a".repeat(43);
        const link = connectionLink(config, code);
        expect(new URL(link).origin).toBe("https://grove.choondoggy.com");
        expect(new URL(link).search).toBe("");
        expect(parseConnectionLink(link)).toEqual({ connection: config, code });
    });
    it.each(["ws://daemon.example/api/e2ee", "wss://user:secret@daemon.example/api/e2ee",
        "wss://daemon.example/api/e2ee?token=x", "wss://daemon.example/other"])("rejects unsafe endpoint %s", (endpoint) => {
        expect(() => validateConnection({ endpoint, key })).toThrow();
    });
    it("does not fall back to HTTP for damaged stored settings or an unconnected Pages client", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        vi.stubGlobal("localStorage", { getItem: () => "broken" });
        await expect(transportFetch("/api/v1/health")).rejects.toThrow();
        vi.stubGlobal("localStorage", { getItem: () => null });
        vi.stubGlobal("location", { hostname: "grove.choondoggy.com" });
        await expect(transportFetch("/api/v1/health")).rejects.toThrow("연결 링크");
        expect(fetch).not.toHaveBeenCalled();
    });
    it("authenticates ciphertext and rejects replay", async () => {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const sender = new Cipher(key);
        const receiver = new Cipher(key);
        const plain = new TextEncoder().encode("transport secret");
        const ciphertext = await sender.seal(plain);
        expect(await receiver.open(ciphertext)).toEqual(plain);
        await expect(receiver.open(ciphertext)).rejects.toThrow();
        const corrupted = new Uint8Array(ciphertext.slice(0));
        corrupted[0] = corrupted[0]! ^ 1;
        await expect(new Cipher(key).open(corrupted.buffer)).rejects.toThrow();
    });
});
