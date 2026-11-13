import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let client: typeof import("../../api/client");
let lifecycle: typeof import("./lifecycle");
let browser: { onLine: boolean };
const session = () => new Response(JSON.stringify({ access_token: "fixture-access", expires_at: "" }));

beforeEach(async () => {
    vi.resetModules();
    browser = { onLine: true };
    vi.stubGlobal("navigator", browser);
    client = await import("../../api/client");
    lifecycle = await import("./lifecycle");
});
afterEach(() => vi.unstubAllGlobals());

describe("인증 전송의 공통 PWA 경계", () => {
    it("호환 확인 전 로그인·페어링·refresh를 전송하지 않는다", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        await expect(client.login("fixture", "browser")).rejects.toMatchObject({ code: "server_unavailable", details: { result_unknown: false } });
        await expect(client.redeemPairing("fixture")).rejects.toMatchObject({ code: "server_unavailable", details: { result_unknown: false } });
        expect(await client.refresh()).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("오프라인 로그인·페어링·refresh를 보내지 않고 복구는 health만 조회한다", async () => {
        const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{"protocol":1}'));
        vi.stubGlobal("fetch", fetch);
        browser.onLine = false;
        await expect(client.login("fixture", "browser")).rejects.toMatchObject({ code: "offline", details: { result_unknown: false } });
        await expect(client.redeemPairing("fixture")).rejects.toMatchObject({ code: "offline", details: { result_unknown: false } });
        expect(await client.refresh()).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        browser.onLine = true;
        await lifecycle.checkCompatibility();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]![0]).toBe("/api/v1/health");
        expect(client.isLoggedIn()).toBe(false);
    });

    it("protocol 불일치에서는 인증 mutation을 보내지 않는다", async () => {
        const fetch = vi.fn(async () => new Response('{"protocol":2}'));
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        await expect(client.login("fixture", "browser")).rejects.toMatchObject({ code: "protocol_mismatch" });
        await expect(client.redeemPairing("fixture")).rejects.toMatchObject({ code: "protocol_mismatch" });
        expect(await client.refresh()).toBeNull();
        await client.logout();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("오프라인 refresh는 열린 탭의 인증을 만료시키지 않고 logout은 로컬 인증만 끝낸다", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response('{"protocol":1}')).mockResolvedValueOnce(session());
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        await client.login("fixture", "browser");
        const owner = client.authGeneration();
        browser.onLine = false;
        expect(await client.refresh()).toEqual({ accessToken: "fixture-access", expiresAt: "" });
        expect(client.authGeneration()).toBe(owner);
        expect(client.lastAuthEnd()).toBeNull();
        await client.logout();
        expect(client.isLoggedIn()).toBe(false);
        expect(client.lastAuthEnd()).toBe("logout");
        expect(client.authGeneration()).not.toBe(owner);
        browser.onLine = true;
        await lifecycle.checkCompatibility();
        expect(await client.refresh()).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each(["login", "pairing", "refresh", "logout"] as const)("별도 %s 응답의 protocol 헤더도 다음 변경을 차단한다", async (kind) => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response('{"protocol":1}'));
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        fetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fixture", expires_at: "" }), {
            headers: { "x-grove-protocol": "2" },
        }));
        if (kind === "login") await client.login("fixture", "browser");
        if (kind === "pairing") await client.redeemPairing("fixture");
        if (kind === "refresh") await client.refresh();
        if (kind === "logout") await client.logout();
        await expect(client.api.post("/projects", {})).rejects.toMatchObject({ code: "protocol_mismatch" });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("차단된 refresh singleflight를 영구 cache하지 않고 명시적인 재확인에서만 복구한다", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response('{"protocol":1}')).mockResolvedValueOnce(session());
        vi.stubGlobal("fetch", fetch);
        expect(await client.refresh()).toBeNull();
        await lifecycle.checkCompatibility();
        const first = client.refresh();
        expect(client.refresh()).toBe(first);
        expect(await first).toEqual({ accessToken: "fixture-access", expiresAt: "" });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each(["login", "pairing"] as const)("%s의 실제 응답 유실은 결과 불명으로 남기고 자동 재전송하지 않는다", async (kind) => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response('{"protocol":1}'))
            .mockRejectedValueOnce(new TypeError("fixture response lost"));
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        await expect(kind === "login" ? client.login("fixture", "browser") : client.redeemPairing("fixture"))
            .rejects.toMatchObject({ code: "network_error", details: { result_unknown: true } });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(client.isLoggedIn()).toBe(false);
    });

    it.each(["login", "pairing"] as const)("cold start 중 %s의 늦은 성공이 logout을 되돌리지 않는다", async (kind) => {
        let release!: (response: Response) => void;
        const pending = new Promise<Response>((resolve) => { release = resolve; });
        const fetch = vi.fn().mockResolvedValueOnce(new Response('{"protocol":1}')).mockReturnValueOnce(pending)
            .mockResolvedValueOnce(new Response("{}"));
        vi.stubGlobal("fetch", fetch);
        await lifecycle.checkCompatibility();
        const rejected = expect(kind === "login" ? client.login("fixture", "browser") : client.redeemPairing("fixture"))
            .rejects.toMatchObject({ code: "auth_session_changed" });
        await client.logout();
        release(session());
        await rejected;
        expect(client.isLoggedIn()).toBe(false);
        expect(client.lastAuthEnd()).toBe("logout");
    });
});
