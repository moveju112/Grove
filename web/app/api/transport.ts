import { loadCredential, saveCredential } from "./e2ee-credentials";

export type Connection = { endpoint: string; key: string };
const CONNECTION_KEY = "grove.e2ee.connection.v1";
const LABEL = new TextEncoder().encode("grove-e2ee-v1");
const text = new TextEncoder();
const decode = new TextDecoder();
const MAX_FRAME = 12 * 1024 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_QUEUE = 2 * 1024 * 1024;

export function base64(bytes: Uint8Array): string {
    let result = "";
    for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(result);
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}

export function validateConnection(value: Connection): Connection {
    const url = new URL(value.endpoint);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && local))
        || url.pathname !== "/api/e2ee" || url.search || url.hash || url.username || url.password) {
        throw new Error("wss://서버/api/e2ee 주소를 입력하세요.");
    }
    const bytes = unbase64(value.key);
    if (bytes.length !== 32 || base64(bytes) !== value.key) throw new Error("서버 공개키가 올바르지 않습니다.");
    return { endpoint: url.href, key: value.key };
}

export function connection(): Connection | null {
    if (typeof localStorage === "undefined") return null;
    const stored = localStorage.getItem(CONNECTION_KEY);
    // 손상·키 변경은 로컬 전송으로 fallback하지 않는다.
    return stored ? validateConnection(JSON.parse(stored) as Connection) : null;
}

export function configureConnection(value: Connection) {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify(validateConnection(value)));
}

export function connectionLink(value: Connection, code?: string): string {
    const valid = validateConnection(value);
    const params = new URLSearchParams({ connect: valid.endpoint, key: valid.key });
    if (code) params.set("pairing", code);
    return `https://grove.choondoggy.com/#${params}`;
}

export function parseConnectionLink(link: string): { connection: Connection; code?: string } {
    const url = new URL(link);
    const params = new URLSearchParams(url.hash.slice(1));
    const endpoint = params.get("connect");
    const key = params.get("key");
    if (!endpoint || !key) throw new Error("서버에서 발급한 연결 링크를 입력하세요.");
    const code = params.get("pairing") ?? undefined;
    if (code && !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("페어링 코드가 올바르지 않습니다.");
    return { connection: validateConnection({ endpoint, key }), code };
}

export class Cipher {
    private counter = 0n;
    constructor(private key: CryptoKey) {}
    private nonce(): Uint8Array<ArrayBuffer> {
        if (this.counter >= 0xffffffffn) throw new Error("암호화 연결을 다시 열어야 합니다.");
        const iv = new Uint8Array(12);
        new DataView(iv.buffer).setBigUint64(4, this.counter++);
        return iv;
    }
    async seal(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
        return crypto.subtle.encrypt({ name: "AES-GCM", iv: this.nonce() }, this.key, bytes);
    }
    async open(bytes: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: this.nonce() }, this.key, bytes));
    }
}

class Channel {
    private queue: Array<string | ArrayBuffer> = [];
    private queued = 0;
    private waiter: { resolve: (value: string | ArrayBuffer) => void; reject: (reason: Error) => void } | null = null;
    private failure: Error | null = null;
    private tx: Cipher | null = null;
    private rx: Cipher | null = null;
    private sends: Promise<void> = Promise.resolve();
    readonly ws: WebSocket;

    constructor(endpoint: string, signal?: AbortSignal | null) {
        this.ws = new WebSocket(endpoint);
        this.ws.binaryType = "arraybuffer";
        this.ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
            if (this.failure) return;
            const size = typeof event.data === "string" ? event.data.length : event.data.byteLength;
            if (size > MAX_FRAME || this.queued + size > MAX_QUEUE) { this.fail(new Error("암호화 응답 한도를 초과했습니다.")); return; }
            if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(event.data); }
            else { this.queue.push(event.data); this.queued += size; }
        };
        this.ws.onerror = () => this.fail(new TypeError("암호화 연결에 실패했습니다."));
        this.ws.onclose = () => this.fail(new TypeError("암호화 연결이 끊겼습니다."));
        const abort = () => this.fail(new DOMException("요청을 취소했습니다.", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        this.ws.addEventListener("close", () => signal?.removeEventListener("abort", abort), { once: true });
        if (signal?.aborted) abort();
    }

    private fail(error: Error) {
        if (this.failure) return;
        this.failure = error;
        this.waiter?.reject(error);
        this.waiter = null;
        this.ws.close();
    }
    close() { this.fail(new TypeError("암호화 연결이 닫혔습니다.")); }
    private async next(): Promise<string | ArrayBuffer> {
        // close 직전에 도착한 authenticated end frame은 먼저 소비한다.
        const value = this.queue.shift();
        if (value !== undefined) {
            this.queued -= typeof value === "string" ? value.length : value.byteLength;
            return value;
        }
        if (this.failure) throw this.failure;
        return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
    }
    async start(pin: string) {
        const timer = setTimeout(() => this.fail(new Error("암호화 연결 확인 시간이 초과됐습니다.")), 10_000);
        try {
            if (this.failure) throw this.failure;
            await new Promise<void>((resolve, reject) => {
                this.ws.addEventListener("open", () => resolve(), { once: true });
                this.ws.addEventListener("close", () => reject(this.failure ?? new Error("연결 실패")), { once: true });
            });
            const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
            const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
            this.ws.send(JSON.stringify({ version: 1, key: base64(publicKey) }));
            const raw = await this.next();
            if (typeof raw !== "string" || raw.length > 512) throw new Error("암호화 handshake 형식 오류");
            const hello = JSON.parse(raw) as { version: number; key: string; signature: string };
            if (hello.version !== 1) throw new Error("지원하지 않는 암호화 버전입니다.");
            const server = unbase64(hello.key);
            const identity = unbase64(pin);
            if (server.length !== 32) throw new Error("서버 키 형식 오류");
            const transcript = concat(LABEL, publicKey, server, identity);
            const verification = await crypto.subtle.importKey("raw", identity, { name: "Ed25519" }, false, ["verify"]);
            if (!await crypto.subtle.verify("Ed25519", verification, unbase64(hello.signature), transcript)) {
                throw new Error("서버 공개키가 일치하지 않습니다. 소유자에게 연결 링크를 확인하세요.");
            }
            const peer = await crypto.subtle.importKey("raw", server, "X25519", false, []);
            const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, pair.privateKey, 256);
            const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
            const salt = await crypto.subtle.digest("SHA-256", transcript);
            const key = (direction: string) => crypto.subtle.deriveKey({
                name: "HKDF", hash: "SHA-256", salt, info: text.encode(`grove-e2ee-v1/${direction}`),
            }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
            this.tx = new Cipher(await key("c2s"));
            this.rx = new Cipher(await key("s2c"));
            if (this.failure) throw this.failure;
        } catch (error) {
            this.close();
            throw error;
        } finally { clearTimeout(timer); }
    }
    send(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        this.sends = this.sends.then(async () => {
            if (this.failure) throw this.failure;
            const sealed = await this.tx!.seal(bytes);
            if (this.ws.bufferedAmount > MAX_QUEUE) throw new Error("전송 대기량을 초과했습니다.");
            this.ws.send(sealed);
        });
        return this.sends;
    }
    async receive(): Promise<Uint8Array<ArrayBuffer>> {
        const raw = await this.next();
        if (typeof raw === "string") throw new Error("암호화되지 않은 응답을 거절했습니다.");
        return this.rx!.open(raw);
    }
}

function scopeOf(config: Connection) { return `${config.endpoint}|${config.key}`; }
async function cookieFor(config: Connection): Promise<string> {
    return loadCredential(scopeOf(config));
}
async function updateCookie(config: Connection, cookie: string) {
    await saveCredential(scopeOf(config), cookie);
}

export async function transportFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (typeof location !== "undefined" && location.hash?.startsWith("#connect=")) {
        throw new Error("서버 연결 링크를 먼저 확인하세요.");
    }
    const config = connection();
    if (!config) {
        if (typeof location !== "undefined" && location.hostname === "grove.choondoggy.com") {
            throw new Error("서버에서 발급한 연결 링크로 연결하세요.");
        }
        return fetch(path, init);
    }
    if (!path.startsWith("/api/v1/")) throw new Error("암호화 API 경로가 아닙니다.");
    const headers = new Headers(init.headers);
    const cookie = await cookieFor(config);
    if (cookie) headers.set("cookie", cookie);
    const body = init.body == null ? new Uint8Array() : new Uint8Array(await new Response(init.body).arrayBuffer());
    if (body.length > MAX_BODY) throw new Error("요청 본문은 8MiB 이하여야 합니다.");
    init.signal?.throwIfAborted();
    const channel = new Channel(config.endpoint, init.signal);
    try {
        await channel.start(config.key);
        await channel.send(text.encode(JSON.stringify({
            kind: "http", path, method: init.method ?? "GET", headers: [...headers.entries()], body: base64(body),
        })));
        const meta = JSON.parse(decode.decode(await channel.receive())) as { type: string; status: number; headers: [string, string][] };
        if (meta.type !== "headers" || meta.status < 200 || meta.status > 599) throw new Error("암호화 응답 형식 오류");
        const responseHeaders = new Headers();
        for (const [name, value] of meta.headers) {
            if (name.toLowerCase() === "set-cookie") {
                const first = value.split(";")[0]!;
                if (!/^grove_refresh[^=]*=/.test(first)) throw new Error("인증 쿠키 형식 오류");
                await updateCookie(config, /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value) ? "" : first);
            } else if (!["content-length", "transfer-encoding", "content-encoding"].includes(name.toLowerCase())) {
                responseHeaders.append(name, value);
            }
        }
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(controller) {
                try {
                    const bytes = await channel.receive();
                    if (bytes.length === 1 && bytes[0] === 2) { controller.close(); channel.close(); return; }
                    if (bytes[0] !== 1 || bytes.length > 48 * 1024 + 1) throw new Error("암호화 응답 순서 오류");
                    controller.enqueue(bytes.slice(1));
                    await channel.send(new Uint8Array([1]));
                } catch (error) { controller.error(error); channel.close(); }
            },
            cancel() { channel.close(); },
        }, { highWaterMark: 1 });
        if (meta.status === 204 || meta.status === 304 || init.method === "HEAD") {
            await stream.cancel();
            return new Response(null, { status: meta.status, headers: responseHeaders });
        }
        return new Response(stream, { status: meta.status, headers: responseHeaders });
    } catch (error) { channel.close(); throw error; }
}

export type TerminalSocket = Pick<WebSocket, "readyState" | "binaryType" | "onopen" | "onmessage" | "onclose" | "send" | "close">;

export function terminalSocket(path: string): TerminalSocket {
    const config = connection();
    if (!config) {
        if (location.hostname === "grove.choondoggy.com") throw new Error("암호화 연결이 필요합니다.");
        return new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`);
    }
    const channel = new Channel(config.endpoint);
    let closed = false;
    const socket = {
        readyState: 0, binaryType: "arraybuffer",
        onopen: null, onmessage: null, onclose: null,
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            if (socket.readyState !== 1 || typeof data !== "string") throw new Error("터미널 연결이 준비되지 않았습니다.");
            void channel.send(concat(new Uint8Array([1]), text.encode(data))).catch(() => socket.close());
        },
        close() {
            if (closed) return;
            closed = true;
            socket.readyState = 3;
            channel.close();
            socket.onclose?.call(socket as unknown as WebSocket, new CloseEvent("close"));
        },
    } as TerminalSocket & { readyState: number };
    void (async () => {
        try {
            await channel.start(config.key);
            if (closed) return;
            await channel.send(text.encode(JSON.stringify({ kind: "ws", path })));
            const ready = await channel.receive();
            if (ready.length !== 1 || ready[0] !== 0) throw new Error("터미널 연결 거절");
            if (closed) return;
            socket.readyState = 1;
            socket.onopen?.call(socket as unknown as WebSocket, new Event("open"));
            while (!closed) {
                const bytes = await channel.receive();
                if (bytes[0] !== 1 && bytes[0] !== 2) throw new Error("터미널 응답 형식 오류");
                const data = bytes[0] === 1 ? decode.decode(bytes.slice(1)) : bytes.slice(1).buffer;
                socket.onmessage?.call(socket as unknown as WebSocket, new MessageEvent("message", { data }));
            }
        } catch { socket.close(); }
    })();
    return socket;
}
