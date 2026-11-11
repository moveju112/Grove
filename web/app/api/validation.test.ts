import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { ContractError, parseContract } from "./validation";

const event = { seq: 1, created_at: "2026-11-11T00:00:00Z", kind: "message.created", project_id: null, session_id: "s", payload: { text: "hello" } };
const draft = { resource_key: "session:s", text: "", revision: 1, device_name: "browser", updated_at: null };

afterEach(() => vi.unstubAllGlobals());

describe("Rust 계약에서 생성한 런타임 검증", () => {
    it("nullable·임의 JSON·추가 필드를 보존한다", () => {
        const value = { ...event, future: true };
        expect(parseContract("EventRecord", value)).toBe(value);
        expect(parseContract("Draft", draft)).toBe(draft);
    });

    it("누락·타입 오류·배열·비유한 숫자를 거절하고 응답 값을 노출하지 않는다", () => {
        for (const value of [{ ...event, seq: "secret-value" }, { ...event, seq: Infinity }, { ...event, project_id: 3 }, [], null]) {
            expect(() => parseContract("EventRecord", value)).toThrow(ContractError);
        }
        const { payload: _, ...missing } = event;
        expect(() => parseContract("EventRecord", missing)).toThrow("$.payload");
        expect(() => parseContract("EventRecord", { ...event, seq: "secret-value" })).not.toThrow("secret-value");
    });

    it("참조 배열 안의 잘못된 필드까지 검사한다", () => {
        const page = { items: [{ ...event, seq: 1 }], has_more_before: false, has_more_after: false, timeline_revision: 1, rewind_boundary_seq: null };
        expect(() => parseContract("MessagePage", page)).toThrow("$.items[0].id");
        expect(parseContract("MessagePage", { ...page, items: [] }).items).toEqual([]);
    });

    it("선택 필드는 생략할 수 있지만 있으면 중첩 타입을 검사한다", () => {
        const turn = {
            id: "t", session_id: "s", status: "running", request_message_id: "m", profile_id: null, agent_id: null, workflow_id: null,
            tools_enabled: true, error: null, usage: {}, step: 1, created_at: "", updated_at: "", finished_at: null, definition: {}, acknowledged_at: null,
        };
        expect(parseContract("Turn", turn)).toBe(turn);
        expect(parseContract("Turn", { ...turn, queue: { ahead: 1, active: 2, limit: 3 } }).queue?.ahead).toBe(1);
        expect(parseContract("Turn", { ...turn, queue: { ahead: 0, active: 1, limit: 1, reason: "account" } }).queue?.reason).toBe("account");
        expect(() => parseContract("Turn", { ...turn, queue: { ahead: 0, active: 1, limit: 1, reason: "credential-secret" } })).toThrow("$.queue.reason");
        expect(() => parseContract("Turn", { ...turn, queue: { ahead: "bad", active: 2, limit: 3 } })).toThrow("$.queue.ahead");
    });

    it("HTTP 성공 응답도 계약이 틀리면 상태에 넣기 전에 거절한다", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...draft, revision: "bad" }))));
        await expect(api.getContract("Draft", "/drafts/session:s")).rejects.toThrow("$.revision");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(draft))));
        await expect(api.getContract("Draft", "/drafts/session:s")).resolves.toEqual(draft);
    });
});
