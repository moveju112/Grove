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
        || !/^\/api\/e2ee(?:\/[0-9a-f]{64})?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
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
    protocol: number | null = null;
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
    /// version 1: 연결당 요청 하나(터미널). version 2: 여러 요청을 한 연결에서 다중화한다.
    async start(pin: string, version: 1 | 2 = 1) {
        const timer = setTimeout(() => this.fail(new TypeError("암호화 연결 확인 시간이 초과됐습니다.")), 10_000);
        try {
            if (this.failure) throw this.failure;
            await new Promise<void>((resolve, reject) => {
                this.ws.addEventListener("open", () => resolve(), { once: true });
                this.ws.addEventListener("error", () => reject(this.failure ?? new TypeError("암호화 연결에 실패했습니다.")), { once: true });
                this.ws.addEventListener("close", () => reject(this.failure ?? new Error("연결 실패")), { once: true });
            });
            const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
            const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
            this.ws.send(JSON.stringify({ version, key: base64(publicKey) }));
            const raw = await this.next();
            if (typeof raw !== "string" || raw.length > 512) throw new Error("암호화 handshake 형식 오류");
            const hello = JSON.parse(raw) as { version: number; key: string; signature: string; protocol?: number; protocol_signature?: string };
            if (hello.version !== version) throw new Error("지원하지 않는 암호화 버전입니다.");
            const server = unbase64(hello.key);
            const identity = unbase64(pin);
            if (server.length !== 32) throw new Error("서버 키 형식 오류");
            const transcript = concat(LABEL, publicKey, server, identity);
            const verification = await crypto.subtle.importKey("raw", identity, { name: "Ed25519" }, false, ["verify"]);
            if (!await crypto.subtle.verify("Ed25519", verification, unbase64(hello.signature), transcript)) {
                throw new Error("서버 공개키가 일치하지 않습니다. 소유자에게 연결 링크를 확인하세요.");
            }
            if (hello.protocol !== undefined || hello.protocol_signature !== undefined) {
                if (!Number.isSafeInteger(hello.protocol) || hello.protocol! < 0 || hello.protocol! > 0xffff_ffff || !hello.protocol_signature) {
                    throw new Error("서버 protocol 증명 형식 오류");
                }
                const version = new Uint8Array(4);
                new DataView(version.buffer).setUint32(0, hello.protocol!);
                const proof = concat(text.encode("grove-e2ee-protocol-v1"), transcript, version);
                if (!await crypto.subtle.verify("Ed25519", verification, unbase64(hello.protocol_signature), proof)) {
                    throw new Error("서버 protocol 증명을 확인하지 못했습니다.");
                }
                this.protocol = hello.protocol!;
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

// ---- 다중화 연결(handshake version 2). 서버 계약: src/e2ee/mux.rs ----
const OPEN = 0x01, ACK = 0x02, CANCEL = 0x03, PING = 0x04;
const HEADERS = 0x11, DATA = 0x12, END = 0x13, FAIL = 0x14, PONG = 0x15;
/// 연결이 살아 있는 동안 주기적으로 확인한다. 서버는 60초 동안 frame이 없으면 연결을 닫는다.
const HEARTBEAT_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
/// 백그라운드 복귀처럼 오래 조용했던 연결은 쓰기 전에 짧게 확인한다.
const QUIET_MS = 20_000;
const RESUME_PING_MS = 3_000;
/// 서버가 이미 닫았을 시간이 지나면 확인 없이 새로 연결한다.
const EXPIRED_MS = 55_000;

type Meta = { type: string; status: number; headers: [string, string][] };
type MuxStream = {
    headers: (meta: Meta) => void;
    data: (bytes: Uint8Array<ArrayBuffer>) => void;
    end: () => void;
    fail: (error: Error) => void;
};

function frame(kind: number, id: number, payload: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(5 + payload.length);
    bytes[0] = kind;
    new DataView(bytes.buffer).setUint32(1, id);
    bytes.set(payload, 5);
    return bytes;
}

export class Mux {
    get protocol(): number | null { return this.channel.protocol; }
    private streams = new Map<number, MuxStream>();
    private pings = new Map<number, () => void>();
    private nextId = 1;
    private lastSeen = Date.now();
    private checking: Promise<boolean> | null = null;
    private heartbeat: ReturnType<typeof setInterval>;
    dead: Error | null = null;

    private constructor(private channel: Channel) {
        this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastSeen < HEARTBEAT_MS) return;
            void this.ping(PING_TIMEOUT_MS).then((alive) => { if (!alive) this.fail(new TypeError("암호화 연결 응답이 없습니다.")); });
        }, HEARTBEAT_MS);
        void this.run();
    }

    static async open(config: Connection): Promise<Mux> {
        const channel = new Channel(config.endpoint);
        await channel.start(config.key, 2);
        return new Mux(channel);
    }

    private async run() {
        try {
            for (;;) {
                const bytes = await this.channel.receive();
                this.lastSeen = Date.now();
                if (bytes.length < 5) throw new Error("암호화 응답 형식 오류");
                const kind = bytes[0]!;
                const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
                const payload = bytes.slice(5);
                if (kind === PONG) { this.pings.get(id)?.(); continue; }
                const stream = this.streams.get(id);
                if (!stream) continue;
                if (kind === HEADERS) stream.headers(JSON.parse(decode.decode(payload)) as Meta);
                else if (kind === DATA) stream.data(payload);
                else if (kind === END) stream.end();
                else if (kind === FAIL) stream.fail(new TypeError("서버가 요청을 처리하지 못했습니다."));
                else throw new Error("암호화 응답 순서 오류");
            }
        } catch (error) {
            this.fail(error instanceof TypeError ? error : new TypeError("암호화 연결이 끊겼습니다."));
        }
    }

    /// 연결이 끊기면 진행 중인 모든 요청을 전송 오류로 끝낸다. 다음 요청은 새 연결을 맺는다.
    fail(error: Error) {
        if (this.dead) return;
        this.dead = error;
        clearInterval(this.heartbeat);
        this.channel.close();
        for (const stream of this.streams.values()) stream.fail(error);
        this.streams.clear();
        for (const resolve of this.pings.values()) resolve();
        this.pings.clear();
    }

    private send(kind: number, id: number, payload?: Uint8Array) {
        return this.channel.send(frame(kind, id, payload));
    }

    /// 응답이 오면 true. 시간 안에 오지 않거나 연결이 끊기면 false.
    ping(timeoutMs: number): Promise<boolean> {
        if (this.dead) return Promise.resolve(false);
        const id = this.nextId++;
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => { this.pings.delete(id); resolve(false); }, timeoutMs);
            this.pings.set(id, () => { clearTimeout(timer); this.pings.delete(id); resolve(!this.dead); });
            this.send(PING, id).catch(() => { clearTimeout(timer); this.pings.delete(id); resolve(false); });
        });
    }

    /// 쓰기 전에 연결이 살아 있는지 판단한다. 오래 조용했으면 짧게 확인하고, 죽었으면 닫는다.
    async usable(): Promise<boolean> {
        if (this.dead) return false;
        const quiet = Date.now() - this.lastSeen;
        if (quiet >= EXPIRED_MS) { this.fail(new TypeError("암호화 연결이 만료됐습니다.")); return false; }
        if (quiet < QUIET_MS) return true;
        this.checking ??= this.ping(RESUME_PING_MS).finally(() => { this.checking = null; });
        const alive = await this.checking;
        if (!alive) this.fail(new TypeError("암호화 연결 응답이 없습니다."));
        return alive;
    }

    request(operation: unknown, method: string, signal?: AbortSignal | null): Promise<{ meta: Meta; body: ReadableStream<Uint8Array<ArrayBuffer>> | null }> {
        if (this.dead) return Promise.reject(this.dead);
        const id = this.nextId++;
        const queue: Uint8Array<ArrayBuffer>[] = [];
        let waiter: { resolve: (value: Uint8Array<ArrayBuffer> | null) => void; reject: (error: Error) => void } | null = null;
        let ended = false;
        let failure: Error | null = null;
        let headed = false;
        let consume = true;
        const done = () => { this.streams.delete(id); signal?.removeEventListener("abort", abort); };
        const cancel = () => { if (this.streams.has(id)) { done(); void this.send(CANCEL, id).catch(() => undefined); } };
        const abort = () => stream.fail(new DOMException("요청을 취소했습니다.", "AbortError"));
        const next = (): Promise<Uint8Array<ArrayBuffer> | null> => {
            const value = queue.shift();
            if (value) return Promise.resolve(value);
            if (failure) return Promise.reject(failure);
            if (ended) return Promise.resolve(null);
            return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
        };
        let settle!: { resolve: (value: { meta: Meta; body: ReadableStream<Uint8Array<ArrayBuffer>> | null }) => void; reject: (error: Error) => void };
        const result = new Promise<{ meta: Meta; body: ReadableStream<Uint8Array<ArrayBuffer>> | null }>((resolve, reject) => { settle = { resolve, reject }; });
        const stream: MuxStream = {
            headers: (meta) => {
                if (headed || meta.type !== "headers" || meta.status < 200 || meta.status > 599) { stream.fail(new TypeError("암호화 응답 형식 오류")); return; }
                headed = true;
                // 본문 없는 응답도 서버의 끝 frame까지는 받아 ACK 흐름을 맞춘다.
                consume = !(meta.status === 204 || meta.status === 304 || method === "HEAD");
                const body = consume ? new ReadableStream<Uint8Array<ArrayBuffer>>({
                    pull: async (controller) => {
                        try {
                            const bytes = await next();
                            if (bytes === null) { controller.close(); done(); return; }
                            controller.enqueue(bytes);
                            void this.send(ACK, id).catch(() => undefined);
                        } catch (error) { controller.error(error); done(); }
                    },
                    cancel: () => cancel(),
                }, { highWaterMark: 1 }) : null;
                settle.resolve({ meta, body });
            },
            data: (bytes) => {
                if (!headed || bytes.length > 48 * 1024) { stream.fail(new TypeError("암호화 응답 순서 오류")); return; }
                if (!consume) { void this.send(ACK, id).catch(() => undefined); return; }
                if (waiter) { const w = waiter; waiter = null; w.resolve(bytes); } else queue.push(bytes);
            },
            end: () => {
                ended = true;
                if (!consume) done();
                if (waiter) { const w = waiter; waiter = null; w.resolve(null); }
            },
            fail: (error) => {
                if (failure || ended) return;
                failure = error;
                cancel();
                if (!headed) settle.reject(error);
                if (waiter) { const w = waiter; waiter = null; w.reject(error); }
            },
        };
        this.streams.set(id, stream);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else this.send(OPEN, id, text.encode(JSON.stringify(operation))).catch(() => stream.fail(new TypeError("암호화 연결이 끊겼습니다.")));
        return result;
    }
}

// 연결 대상별로 다중화 연결 하나를 공유한다. 연결 중인 요청은 같은 연결을 기다린다.
let shared: { scope: string; mux: Promise<Mux> } | null = null;
async function muxFor(config: Connection): Promise<Mux> {
    const scope = scopeOf(config);
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = shared?.scope === scope ? shared : null;
        if (current) {
            const mux = await current.mux.catch(() => null);
            if (mux && await mux.usable()) return mux;
            // 먼저 확인한 요청 하나만 새 연결을 만든다. 나머지는 그 연결을 함께 기다린다.
            if (shared !== current) continue;
        }
        const opening = Mux.open(config);
        shared = { scope, mux: opening };
        opening.catch(() => { if (shared?.mux === opening) shared = null; });
        return opening;
    }
    return shared?.scope === scope ? shared.mux : Mux.open(config);
}

function transportError(error: unknown): Error {
    if (error instanceof DOMException && error.name === "AbortError") return error;
    return error instanceof TypeError ? error : new TypeError(error instanceof Error ? error.message : "암호화 연결에 실패했습니다.");
}

function scopeOf(config: Connection) { return `${config.endpoint}|${config.key}`; }
/// pin과 연결 transcript에 결합된 protocol만 반환한다. 구형 서버·로컬 HTTP는 기존 health 확인을 쓴다.
export async function transportProtocol(): Promise<number | null> {
    const config = connection();
    return config ? (await muxFor(config)).protocol : null;
}
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
    const method = init.method ?? "GET";
    let response: Awaited<ReturnType<Mux["request"]>>;
    try {
        const mux = await muxFor(config);
        init.signal?.throwIfAborted();
        response = await mux.request({ kind: "http", path, method, headers: [...headers.entries()], body: base64(body) }, method, init.signal);
    } catch (error) {
        // 연결 실패는 모두 전송 오류(TypeError)로 통일한다. 조회는 한 번 재시도하고, 변경은 결과 확인으로 넘어간다.
        throw transportError(error);
    }
    const { meta, body: stream } = response;
    const responseHeaders = new Headers();
    for (const [name, value] of meta.headers) {
        if (name.toLowerCase() === "set-cookie") {
            const first = value.split(";")[0]!;
            if (!/^grove_refresh[^=]*=/.test(first)) { await stream?.cancel(); throw new Error("인증 쿠키 형식 오류"); }
            await updateCookie(config, /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value) ? "" : first);
        } else if (!["content-length", "transfer-encoding", "content-encoding"].includes(name.toLowerCase())) {
            responseHeaders.append(name, value);
        }
    }
    return new Response(stream, { status: meta.status, headers: responseHeaders });
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
