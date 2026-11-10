import { describe, expect, it } from "vitest";
import { type SendOptions, resolveOptions } from "./sendOptions";

const base: SendOptions = { mode: "model", profileId: null, agentId: null, tools: false };

describe("resolveOptions", () => {
    it("선택이 없으면 첫 프로필을 쓴다(다른 옵션 변경과 무관)", () => {
        expect(resolveOptions({ ...base, mode: "model" }, ["p1", "p2"], []).profileId).toBe("p1");
    });
    it("목록에 없는 저장 프로필은 첫 프로필로 바꾼다", () => {
        expect(resolveOptions({ ...base, profileId: "gone" }, ["p1"], []).profileId).toBe("p1");
    });
    it("목록에 있는 선택은 유지한다", () => {
        expect(resolveOptions({ ...base, profileId: "p2" }, ["p1", "p2"], []).profileId).toBe("p2");
    });
    it("프로필 목록을 아직 못 불러왔거나 비어 있으면 null", () => {
        expect(resolveOptions({ ...base, profileId: "p1" }, undefined, undefined).profileId).toBeNull();
        expect(resolveOptions(base, [], []).profileId).toBeNull();
    });
    it("목록에 없는 에이전트는 '에이전트 없음'으로 바꾸고 목록 로딩 전에는 유지한다", () => {
        expect(resolveOptions({ ...base, agentId: "old" }, ["p1"], ["worker"]).agentId).toBeNull();
        expect(resolveOptions({ ...base, agentId: "worker" }, ["p1"], ["worker"]).agentId).toBe("worker");
        expect(resolveOptions({ ...base, agentId: "worker" }, ["p1"], undefined).agentId).toBe("worker");
    });
});
