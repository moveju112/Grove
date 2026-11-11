import { describe, expect, it } from "vitest";
import { type SendOptions, capabilityProblem, resolveOptions, sendOptionsSignature } from "./sendOptions";
import type { ModelCapabilities } from "../api/generated";

const base: SendOptions = { mode: "model", profileId: null, agentId: null, tools: false };

describe("sendOptionsSignature", () => {
    it("생략한 auto와 명시한 auto, 속성 순서는 요청의 정체성을 바꾸지 않는다", () => {
        expect(sendOptionsSignature(base, ["a"])).toBe(sendOptionsSignature({ tools: false, agentId: null, profileId: null, mode: "model", effort: "auto" }, ["a"]));
    });
    it("대상·권한·첨부 순서 변경은 별도 요청이다", () => {
        const original = sendOptionsSignature(base, ["a", "b"]);
        expect(sendOptionsSignature({ ...base, profileId: "other" }, ["a", "b"])).not.toBe(original);
        expect(sendOptionsSignature({ ...base, tools: true }, ["a", "b"])).not.toBe(original);
        expect(sendOptionsSignature(base, ["b", "a"])).not.toBe(original);
    });
});

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

describe("capabilityProblem", () => {
    const unknown: ModelCapabilities = { context_tokens: null, max_output_tokens: null, images: null, tools: null, effort: null, temperature: null, pdf: false, fast: false };
    it("미확인 지원을 미지원으로 단정하지 않는다", () => {
        expect(capabilityProblem(unknown, { ...base, tools: true, effort: "high" }, true)).toBeNull();
        expect(capabilityProblem(undefined, base, false)).toBeNull();
    });
    it("미지원 요청은 명시적으로 되돌리게 하고 저장 모드는 막지 않는다", () => {
        const no = { ...unknown, images: false, tools: false, effort: false };
        expect(capabilityProblem(no, { ...base, tools: true }, false)).toContain("도구 루프 미지원");
        expect(capabilityProblem(no, { ...base, effort: "high" }, false)).toContain("추론 강도 미지원");
        expect(capabilityProblem(no, { ...base, effort: "auto" }, false)).toBeNull();
        expect(capabilityProblem(no, base, true)).toContain("이미지 입력 미지원");
        expect(capabilityProblem(no, { ...base, mode: "save", tools: true }, true)).toBeNull();
    });
});
