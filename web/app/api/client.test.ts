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
});
