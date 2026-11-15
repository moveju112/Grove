import { describe, expect, it } from "vitest";
import { type SendOptions, capabilityProblem, initialProfile, resolveOptions, sendOptionsSignature, serviceTierForProfile } from "./sendOptions";
import type { ModelCapabilities } from "../api/generated";

const base: SendOptions = { mode: "model", profileId: null, agentId: null, tools: false };

describe("sendOptionsSignature", () => {
    it("생략한 auto와 명시한 auto, 속성 순서는 요청의 정체성을 바꾸지 않는다", () => {
        expect(sendOptionsSignature(base, ["a"])).toBe(sendOptionsSignature({ tools: false, agentId: null, profileId: null, mode: "model", effort: "auto" }, ["a"]));
    });
    it("대상·권한·첨부 순서 변경은 별도 요청이다", () => {
        const original = sendOptionsSignature(base, ["a", "b"]);
        expect(sendOptionsSignature({ ...base, profileId: "other" }, ["a", "b"])).not.toBe(original);
        expect(sendOptionsSignature({ ...base, model: "another-model" }, ["a", "b"])).not.toBe(original);
        expect(sendOptionsSignature({ ...base, model: null }, ["a", "b"])).toBe(original);
        expect(sendOptionsSignature({ ...base, tools: true }, ["a", "b"])).not.toBe(original);
        expect(sendOptionsSignature({ ...base, serviceTier: "priority" }, ["a", "b"])).not.toBe(original);
        expect(sendOptionsSignature({ ...base, serviceTier: null }, ["a", "b"])).toBe(original);
        expect(sendOptionsSignature(base, ["b", "a"])).not.toBe(original);
    });
});

describe("resolveOptions", () => {
    it("선택이 없으면 첫 프로필을 쓴다(다른 옵션 변경과 무관)", () => {
        expect(resolveOptions({ ...base, mode: "model" }, ["p1", "p2"], []).profileId).toBe("p1");
    });
    it("목록에서 사라진 명시적 선택을 다른 공급자로 조용히 바꾸지 않는다", () => {
        expect(resolveOptions({ ...base, profileId: "gone" }, ["p1"], []).profileId).toBe("gone");
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
    it("Fast 꺼짐은 Codex에 명시하고 미지원 공급자로 바꿔도 정상 전송을 막지 않는다", () => {
        const codex = { ...unknown, fast: true };
        expect(serviceTierForProfile(undefined, codex)).toBe("default");
        expect(serviceTierForProfile(null, codex)).toBe("default");
        expect(serviceTierForProfile("default", codex)).toBe("default");
        expect(serviceTierForProfile("default", unknown)).toBeNull();
        expect(serviceTierForProfile(null, unknown)).toBeNull();
        expect(serviceTierForProfile("priority", unknown)).toBe("priority");
        expect(capabilityProblem(unknown, { ...base, serviceTier: serviceTierForProfile("default", unknown) }, false)).toBeNull();
    });
    it("미확인 지원을 미지원으로 단정하지 않는다", () => {
        expect(capabilityProblem(unknown, { ...base, tools: true, effort: "high" }, true)).toBeNull();
        expect(capabilityProblem(undefined, base, false)).toBeNull();
    });
    it("미지원 요청은 명시적으로 되돌리게 하고 저장 모드는 막지 않는다", () => {
        const no = { ...unknown, images: false, tools: false, effort: false };
        expect(capabilityProblem(no, { ...base, tools: true }, false)).toContain("도구 루프 미지원");
        expect(capabilityProblem(no, { ...base, effort: "high" }, false)).toContain("추론 미지원");
        expect(capabilityProblem(no, { ...base, effort: "auto" }, false)).toBeNull();
        expect(capabilityProblem(no, base, true)).toContain("이미지 입력 미지원");
        expect(capabilityProblem(no, { ...base, mode: "save", tools: true }, true)).toBeNull();
    });
    it("모델 목록에 없는 추론·속도는 초안을 바꾸지 않고 전송 전에 막는다", () => {
        const model = { id: "limited", name: "Limited", reasoning_efforts: ["low", "high"], service_tiers: [] };
        const codex = { ...unknown, fast: true };
        expect(capabilityProblem(codex, { ...base, effort: "max" }, false, model)).toContain("추론 옵션");
        expect(capabilityProblem(codex, { ...base, serviceTier: "priority" }, false, model)).toContain("속도");
        expect(capabilityProblem(codex, { ...base, effort: "high", serviceTier: "default" }, false, model)).toBeNull();
    });
});

describe("새 입력창의 기본 모델", () => {
    it("범위별 기본값이 기기 선택보다 우선하고 미설정일 때만 기기/첫 모델을 쓴다", () => {
        expect(initialProfile("project", "device", ["first"])).toBe("project");
        expect(initialProfile("", "device", ["first"])).toBe("device");
        expect(initialProfile(null, null, ["first"])).toBe("first");
        expect(initialProfile(null, null, [])).toBeNull();
    });
    it("사라진 기본값이나 기기 선택도 다른 공급자로 자동 교체하지 않는다", () => {
        expect(initialProfile("gone", "device", ["first"])).toBe("gone");
        expect(initialProfile(null, "gone", ["first"])).toBe("gone");
    });
});
