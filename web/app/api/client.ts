// 공용 API 클라이언트. 모든 상태 변경 요청에 Idempotency-Key를 붙이고 표준 오류를 ApiError로 바꾼다.
// 인증: 브라우저 로그인 → access token(메모리 전용) + HttpOnly refresh 쿠키.

import type { ContractTypes } from "./generated.metadata";
import { ContractError, parseContract } from "./validation";

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public retryable = false,
        public details?: unknown,
        public requestId?: string,
    ) {
        super(message);
    }
}

export type Session = { accessToken: string; expiresAt: string };

/// 이 화면이 아는 서버 protocol(서버 `PROTOCOL_VERSION`과 같아야 한다). 바뀌면 함께 올린다.
export const PROTOCOL = 1;
let protocolMismatch: number | null = null;
const protocolListeners = new Set<(server: number | null) => void>();

export function onProtocolMismatch(fn: (server: number | null) => void): () => void {
    protocolListeners.add(fn);
    fn(protocolMismatch);
    return () => protocolListeners.delete(fn);
}

/// 응답의 서버 protocol을 확인한다. 다르면 이후 변경 요청을 막고 새로고침을 안내한다.
export function checkProtocol(resp: Response) {
    const v = resp.headers.get("x-grove-protocol");
    if (v === null) return;
    const server = Number(v);
    if (Number.isFinite(server) && server !== PROTOCOL && protocolMismatch !== server) {
        protocolMismatch = server;
        for (const l of protocolListeners) l(server);
    }
}

/// 서버가 알린 기능 목록(NET-001). 이벤트 `hello`에서 갱신한다. 아직 모르면 null.
let capabilities: ReadonlySet<string> | null = null;
const capabilityListeners = new Set<() => void>();

export function setCapabilities(list: unknown) {
    if (!Array.isArray(list)) return;
    const next = new Set(list.filter((x): x is string => typeof x === "string"));
    if (capabilities && capabilities.size === next.size && [...next].every((c) => capabilities!.has(c))) return;
    capabilities = next;
    for (const l of capabilityListeners) l();
}

export function onCapabilities(fn: () => void): () => void {
    capabilityListeners.add(fn);
    return () => capabilityListeners.delete(fn);
}

/// 기능 지원 여부. 아직 목록을 받지 못했으면 null(서버가 `x-grove-require`로 다시 확인한다).
export function hasCapability(name: string): boolean | null {
    return capabilities === null ? null : capabilities.has(name);
}

let current: Session | null = null;
let refreshing: Promise<Session | null> | null = null;
const listeners = new Set<(s: Session | null) => void>();

export function onAuthChange(fn: (s: Session | null) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/// 마지막으로 로그인이 끝난 이유(로그인 화면 안내용, UI-027). expired: refresh 실패로 만료, logout: 사용자가 로그아웃.
let authEnd: "expired" | "logout" | null = null;
export function lastAuthEnd(): "expired" | "logout" | null {
    return authEnd;
}

function setSession(s: Session | null) {
    if (s) authEnd = null;
    current = s;
    for (const l of listeners) l(s);
}

export function isLoggedIn(): boolean {
    return current !== null;
}

export function newKey(): string {
    return crypto.randomUUID();
}

async function parse(resp: Response): Promise<unknown> {
    const text = await resp.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function toError(status: number, body: unknown, requestId?: string): ApiError {
    const e = (body as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } })?.error;
    return new ApiError(status, e?.code ?? "http_" + status, e?.message ?? `HTTP ${status}`, e?.retryable ?? false, e?.details, requestId);
}

export async function login(token: string, name: string): Promise<void> {
    const resp = await fetch("/api/v1/auth/browser-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name }),
        credentials: "same-origin",
    });
    const body = await parse(resp);
    if (!resp.ok) throw toError(resp.status, body);
    const b = body as { access_token: string; expires_at: string };
    setSession({ accessToken: b.access_token, expiresAt: b.expires_at });
}

/// refresh 쿠키로 access token을 다시 받는다. 동시 호출은 하나로 합친다(singleflight).
export function refresh(): Promise<Session | null> {
    if (!refreshing) {
        refreshing = (async () => {
            try {
                const resp = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin" });
                if (!resp.ok) {
                    // 로그인된 상태에서 refresh가 거부되면 만료다(처음 열 때 쿠키 없음은 만료 안내 대상 아님).
                    if (current) authEnd = "expired";
                    setSession(null);
                    return null;
                }
                const b = (await resp.json()) as { access_token: string; expires_at: string };
                const s = { accessToken: b.access_token, expiresAt: b.expires_at };
                setSession(s);
                return s;
            } catch {
                return current;
            } finally {
                refreshing = null;
            }
        })();
    }
    return refreshing;
}

export async function logout(): Promise<void> {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    authEnd = "logout";
    setSession(null);
}

export function accessToken(): string | null {
    return current?.accessToken ?? null;
}

/// requires: 이 요청에 필요한 서버 기능. 서버에 없으면 실행하지 않고 `capability_missing`으로 거절된다.
type Opts = { key?: string; signal?: AbortSignal; requires?: string[]; contract?: keyof ContractTypes; timeoutMs?: number };

export const REQUEST_TIMEOUT_MS = 300_000;

/// timeout·화면 취소는 응답 대기만 끝낸다. 변경 결과가 불명확하면 같은 idempotency key로만 확인한다.
async function boundedRequest<T>(opts: Opts, mutation: boolean, operation: (send: (url: string, init?: RequestInit) => Promise<Response>) => Promise<T>): Promise<T> {
    const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new ApiError(400, "invalid_request", "timeoutMs는 양수여야 합니다");
    const controller = new AbortController();
    let cause: "cancelled" | "request_timeout" = "cancelled";
    let requestId: string | undefined;
    const abort = () => controller.abort();
    const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
            const unknown = mutation && requestId !== undefined;
            const message = cause === "request_timeout" ? "응답 대기 시간이 초과됐습니다" : "요청 대기를 취소했습니다";
            reject(new ApiError(0, cause, message + (unknown ? ". 서버 작업은 계속 실행될 수 있으니 같은 요청의 결과를 확인하세요" : ""),
                cause === "request_timeout" || unknown, { result_unknown: unknown, idempotency_key: opts.key }, requestId));
        }, { once: true });
    });
    const timer = setTimeout(() => {
        cause = "request_timeout";
        controller.abort();
    }, timeout);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    const send = (url: string, init: RequestInit = {}) => {
        controller.signal.throwIfAborted();
        requestId = newKey();
        const headers = new Headers(init.headers);
        headers.set("x-request-id", requestId);
        headers.set("x-grove-protocol", String(PROTOCOL));
        return fetch(url, { ...init, headers, signal: controller.signal });
    };
    try {
        if (controller.signal.aborted) return await interrupted;
        return await Promise.race([operation(send), interrupted]);
    } catch (error) {
        if (controller.signal.aborted) return await interrupted;
        if (error instanceof ApiError || error instanceof ContractError) throw error;
        if (error instanceof TypeError) {
            throw new ApiError(0, "network_error", "서버 응답을 받지 못했습니다. 변경 요청은 같은 키로 결과를 확인하세요", true,
                { result_unknown: mutation && requestId !== undefined, idempotency_key: opts.key }, requestId);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
    }
}

export async function request<T>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
    if (method !== "GET" && protocolMismatch !== null) {
        throw new ApiError(409, "protocol_mismatch", "화면 버전이 서버와 맞지 않습니다. 새로고침한 뒤 다시 시도하세요");
    }
    // 같은 key로 재전송하므로 access token 만료 후 재시도해도 중복 실행되지 않는다.
    if (method !== "GET" && !opts.key) opts = { ...opts, key: newKey() };
    return boundedRequest(opts, method !== "GET", async (fetchRequest) => {
        const send = async () => {
            const headers: Record<string, string> = {};
            if (current) headers.authorization = `Bearer ${current.accessToken}`;
            if (body !== undefined) headers["content-type"] = "application/json";
            if (opts.requires?.length) headers["x-grove-require"] = opts.requires.join(",");
            if (method !== "GET") headers["idempotency-key"] = opts.key!;
            return fetchRequest("/api/v1" + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                credentials: "same-origin",
            });
        };
        let resp = await send();
        if (resp.status === 401 && (await refresh())) resp = await send();
        checkProtocol(resp);
        const parsed = await parse(resp);
        if (!resp.ok) throw toError(resp.status, parsed, resp.headers.get("x-request-id") ?? undefined);
        return (opts.contract ? parseContract(opts.contract, parsed) : parsed) as T;
    });
}

/// 바이너리 응답 GET(터미널 화면 등). 인증 만료 시 한 번 갱신 후 재시도한다.
export async function rawGet(path: string, opts: Opts = {}): Promise<ArrayBuffer> {
    return boundedRequest(opts, false, async (fetchRequest) => {
        const send = () =>
            fetchRequest("/api/v1" + path, { headers: current ? { authorization: `Bearer ${current.accessToken}` } : {}, credentials: "same-origin" });
        let resp = await send();
        if (resp.status === 401 && (await refresh())) resp = await send();
        checkProtocol(resp);
        if (!resp.ok) throw toError(resp.status, await parse(resp), resp.headers.get("x-request-id") ?? undefined);
        return resp.arrayBuffer();
    });
}

export const api = {
    getContract: <K extends keyof ContractTypes>(contract: K, p: string, o?: Opts) =>
        request<ContractTypes[K]>("GET", p, undefined, { ...o, contract }),
    get: <T>(p: string, o?: Opts) => request<T>("GET", p, undefined, o),
    post: <T>(p: string, b: unknown = {}, o?: Opts) => request<T>("POST", p, b, o),
    put: <T>(p: string, b: unknown, o?: Opts) => request<T>("PUT", p, b, o),
    patch: <T>(p: string, b: unknown, o?: Opts) => request<T>("PATCH", p, b, o),
    del: <T>(p: string, o?: Opts) => request<T>("DELETE", p, undefined, o),
};
