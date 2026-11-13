import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { callbackData, uncertain } from "../../api/mcpOAuth";

describe("MCP OAuth callback boundary", () => {
    const popup = {} as Window;
    const origin = "https://grove.example";
    const data = { type: "grove-mcp-oauth", state: "one-use-state", code: "fixture-code", error: null, iss: "https://issuer.example" };
    const event = (changes: Partial<MessageEvent> = {}) => ({ source: popup, origin, data, ...changes }) as MessageEvent;
    it("requires the original window, same origin and exact state", () => {
        expect(callbackData(event(), origin, popup, data.state)).toEqual(data);
        expect(callbackData(event({ origin: "https://evil.example" }), origin, popup, data.state)).toBeNull();
        expect(callbackData(event({ source: {} as Window }), origin, popup, data.state)).toBeNull();
        expect(callbackData(event(), origin, popup, "other")).toBeNull();
        expect(callbackData(event(), origin, null, data.state)).toBeNull();
        expect(callbackData(event(), origin, popup, "")).toBeNull();
    });
    it("rejects mixed outcomes and missing issuer", () => {
        expect(callbackData(event({ data: { ...data, error: "denied" } }), origin, popup, data.state)).toBeNull();
        expect(callbackData(event({ data: { ...data, iss: null } }), origin, popup, data.state)).toBeNull();
        expect(callbackData(event({ data: { ...data, code: null, error: "denied" } }), origin, popup, data.state)?.error).toBe("denied");
    });
    it("preserves uncertain exchange outcomes instead of enabling a new request", () => {
        expect(uncertain(new ApiError(409, "result_unknown", "unknown"))).toBe(true);
        expect(uncertain(new ApiError(0, "network_error", "lost"))).toBe(true);
        expect(uncertain(new ApiError(503, "unavailable", "unavailable"))).toBe(true);
        expect(uncertain(new ApiError(409, "revision_conflict", "changed"))).toBe(false);
        expect(uncertain(new ApiError(403, "forbidden", "denied"))).toBe(false);
    });
});
