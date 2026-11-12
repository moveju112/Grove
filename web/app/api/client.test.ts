import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let client: typeof import("./client");
beforeEach(async () => {
    vi.resetModules();
    client = await import("./client");
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("HTTP 요청 식별·timeout·취소 계약", () => {
    it.each(["json", "binary"] as const)("headers 뒤에 인증이 바뀌어도 늦은 %s 오류 본문을 전달하지 않는다", async (kind) => {
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status: 403 });
        const session = () => new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" }));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(session()).mockResolvedValueOnce(response)
            .mockResolvedValueOnce(new Response("{}")).mockResolvedValueOnce(session()));
        await client.redeemPairing("fixture-one");
        const result = expect(kind === "json" ? client.api.get("/projects") : client.rawGet("/files"))
            .rejects.toMatchObject({ code: "auth_session_changed" });
        await vi.waitFor(() => expect(response.bodyUsed).toBe(true));
        await client.logout();
        await client.redeemPairing("fixture-two");
        body.enqueue(new TextEncoder().encode('{"error":{"code":"private_fixture","message":"old session fixture"}}'));
        body.close();
        await result;
    });
    it("서버 로그아웃을 마치기 전에 다음 등록 요청을 보내 새 쿠키를 폐기하지 않는다", async () => {
        let release!: (r: Response) => void;
        let started!: () => void;
        const pending = new Promise<Response>((resolve) => { release = resolve; });
        const observed = new Promise<void>((resolve) => { started = resolve; });
        const session = () => new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" }));
        const fetch = vi.fn().mockResolvedValueOnce(session())
            .mockImplementationOnce(() => { started(); return pending; }).mockResolvedValueOnce(session());
        vi.stubGlobal("fetch", fetch);
        await client.redeemPairing("fixture-one");
        const leaving = client.logout();
        await observed;
        const entering = client.redeemPairing("fixture-two");
        try {
            expect(client.isLoggedIn()).toBe(false);
            expect(fetch).toHaveBeenCalledTimes(2);
            release(new Response("{}"));
            await Promise.all([leaving, entering]);
            expect(fetch).toHaveBeenCalledTimes(3);
            expect(client.isLoggedIn()).toBe(true);
        } finally { release(new Response("{}")); }
    });
    it("이전 인증의 401 변경 요청을 다음 로그인 자격으로 재전송하지 않는다", async () => {
        let release!: (r: Response) => void;
        const response = new Promise<Response>((resolve) => { release = resolve; });
        const session = () => new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" }));
        const fetch = vi.fn().mockResolvedValueOnce(session()).mockReturnValueOnce(response)
            .mockResolvedValueOnce(new Response("{}")).mockResolvedValueOnce(session());
        vi.stubGlobal("fetch", fetch);
        await client.redeemPairing("fixture-one");
        const result = expect(client.api.post("/projects", {}, { key: "old-operation" })).rejects.toMatchObject({
            code: "auth_session_changed", retryable: false, details: { result_unknown: false },
        });
        await client.logout();
        await client.redeemPairing("fixture-two");
        release(new Response("{}", { status: 401 }));
        await result;
        expect(fetch).toHaveBeenCalledTimes(4);
    });
    it.each(["json", "binary"] as const)("이전 인증의 늦은 %s 조회 결과를 새 로그인에 전달하지 않는다", async (kind) => {
        let release!: (r: Response) => void;
        const response = new Promise<Response>((resolve) => { release = resolve; });
        const session = () => new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" }));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(session()).mockReturnValueOnce(response)
            .mockResolvedValueOnce(new Response("{}")).mockResolvedValueOnce(session()));
        await client.redeemPairing("fixture-one");
        const result = expect(kind === "json" ? client.api.get("/projects") : client.rawGet("/files"))
            .rejects.toMatchObject({ code: "auth_session_changed", details: { result_unknown: false } });
        await client.logout();
        await client.redeemPairing("fixture-two");
        release(new Response("{}"));
        await result;
    });
    it("로그아웃보다 늦게 끝난 refresh가 이전 로그인을 되살리지 않는다", async () => {
        let releaseRefresh!: (r: Response) => void;
        let releaseLogout!: (r: Response) => void;
        const refreshResponse = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
        const logoutResponse = new Promise<Response>((resolve) => { releaseLogout = resolve; });
        vi.stubGlobal("fetch", vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fixture-initial", expires_at: "" })))
            .mockReturnValueOnce(refreshResponse)
            .mockReturnValueOnce(logoutResponse));
        await client.redeemPairing("fixture-pairing");
        let ended!: () => void;
        const out = new Promise<void>((resolve) => { ended = resolve; });
        const off = client.onAuthChange((s) => { if (!s) ended(); });
        const renewing = client.refresh();
        const leaving = client.logout();
        try {
            releaseLogout(new Response("{}"));
            await out;
            releaseRefresh(new Response(JSON.stringify({ access_token: "fixture-stale", expires_at: "" })));
            await Promise.all([renewing, leaving]);
            expect(client.isLoggedIn()).toBe(false);
            expect(await client.refresh()).toBeNull();
        } finally {
            off();
        }
    });
    it("access refresh는 소유 세대를 유지하고 로그아웃 뒤 재로그인해도 이전 비동기 작업의 세대는 되살리지 않는다", async () => {
        const session = () => new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" }));
        const fetch = vi.fn()
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(new Response("{}"))
            .mockResolvedValueOnce(session());
        vi.stubGlobal("fetch", fetch);
        await client.redeemPairing("fixture-pairing");
        const owner = client.authGeneration();
        await client.refresh();
        expect(client.authGeneration()).toBe(owner);
        await client.logout();
        const ended = client.authGeneration();
        expect(ended).not.toBe(owner);
        await client.redeemPairing("fixture-next-pairing");
        expect(client.isLoggedIn()).toBe(true);
        expect(client.authGeneration()).toBe(ended);
        expect(client.authGeneration()).not.toBe(owner);
    });
    it("timeout은 서버 취소로 취급하지 않고 같은 변경 키를 보존한다", async () => {
        vi.useFakeTimers();
        const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
        vi.stubGlobal("fetch", fetch);
        const result = client.api.post("/projects", {}, { key: "same-operation", timeoutMs: 50 });
        const rejected = expect(result).rejects.toMatchObject({
            code: "request_timeout", retryable: true,
            details: { result_unknown: true, idempotency_key: "same-operation" },
        });
        await vi.advanceTimersByTimeAsync(50);
        await rejected;
        expect(fetch).toHaveBeenCalledTimes(1);
        const init = fetch.mock.calls[0]![1] as RequestInit;
        expect(init.signal?.aborted).toBe(true);
        expect(new Headers(init.headers).get("idempotency-key")).toBe("same-operation");
    });

    it("headers를 받은 뒤 body가 멈춰도 timeout이 적용된다", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))));
        const rejected = expect(client.api.get("/projects", { timeoutMs: 20 })).rejects.toMatchObject({ code: "request_timeout" });
        await vi.advanceTimersByTimeAsync(20);
        await rejected;
    });

    it("이미 취소된 요청은 전송하지 않고 실행 중 취소는 결과 불명으로 남긴다", async () => {
        const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
        vi.stubGlobal("fetch", fetch);
        const before = new AbortController();
        before.abort();
        await expect(client.api.post("/projects", {}, { signal: before.signal })).rejects.toMatchObject({
            code: "cancelled", retryable: false, details: { result_unknown: false },
        });
        expect(fetch).not.toHaveBeenCalled();
        const during = new AbortController();
        const rejected = expect(client.api.post("/projects", {}, { signal: during.signal })).rejects.toMatchObject({
            code: "cancelled", retryable: true, details: { result_unknown: true },
        });
        during.abort();
        await rejected;
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("인증 재시도는 transport ID만 바꾸고 idempotency key는 유지한다", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response("{}", { status: 401 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-token", expires_at: "" })))
            .mockResolvedValueOnce(new Response("{}"));
        vi.stubGlobal("fetch", fetch);
        await client.api.post("/projects", {});
        const first = new Headers((fetch.mock.calls[0]![1] as RequestInit).headers);
        const second = new Headers((fetch.mock.calls[2]![1] as RequestInit).headers);
        expect(first.get("idempotency-key")).toBe(second.get("idempotency-key"));
        expect(first.get("x-request-id")).not.toBe(second.get("x-request-id"));
        expect(first.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("서버 오류의 request ID와 표준 코드를 보존한다", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
            error: { code: "busy", message: "busy", retryable: true },
        }), { status: 409, headers: { "x-request-id": "server-id" } })));
        await expect(client.api.get("/projects")).rejects.toMatchObject({ code: "busy", requestId: "server-id", retryable: true });
    });

    it("네트워크 단절도 자동 재실행하지 않고 표준 오류로 돌려준다", async () => {
        const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
        vi.stubGlobal("fetch", fetch);
        await expect(client.api.post("/projects", {}, { key: "same" })).rejects.toMatchObject({
            code: "network_error", details: { result_unknown: true, idempotency_key: "same" },
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("바이너리 조회에도 timeout을 적용하고 성공 시 timer를 정리한다", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))));
        expect(new Uint8Array(await client.rawGet("/terminals/t/screen"))).toEqual(new Uint8Array([1, 2]));
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([401, 410])("일회용 페어링은 HTTP %s나 응답 유실 때 자동 refresh·재등록하지 않는다", async (status) => {
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            error: { code: "pairing_unavailable", message: "사용됨" },
        }), { status }));
        vi.stubGlobal("fetch", fetch);
        await expect(client.redeemPairing("one-time-code")).rejects.toMatchObject({ code: "pairing_unavailable" });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]![0]).toBe("/api/v1/auth/pairing");
        fetch.mockRejectedValueOnce(new TypeError("connection lost"));
        await expect(client.redeemPairing("one-time-code")).rejects.toMatchObject({
            code: "network_error", details: { result_unknown: true },
        });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("페어링 결과의 access 자격은 메모리 세션에만 반영한다", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "temporary-access", expires_at: "2026-01-01T00:00:00Z" })));
        vi.stubGlobal("fetch", fetch);
        await client.redeemPairing("one-time-code");
        expect(client.accessToken()).toBe("temporary-access");
        const init = fetch.mock.calls[0]![1] as RequestInit;
        expect(init.credentials).toBe("same-origin");
        expect(JSON.parse(init.body as string)).toEqual({ code: "one-time-code" });
        await expect(client.redeemPairing("another-code")).rejects.toMatchObject({ code: "already_authenticated" });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
