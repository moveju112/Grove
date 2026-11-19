import { describe, expect, it } from "vitest";
import type { AvailableModel, ModelProfile } from "../api/generated";
import { catalogModel, modelEfforts, sortModels } from "./model-catalog";

const model = (id: string, name = id): AvailableModel => ({ id, name });

describe("모델별 추론 옵션", () => {
    it("Claude의 기본 모델과 명시적으로 고른 모델 각각의 목록을 사용한다", () => {
        const profile = { protocol: "claude_code", model: "default" } as ModelProfile;
        const opus = ["low", "medium", "high", "xhigh", "max"];
        const rows = [
            { ...model("default", "Opus 5.5"), reasoning_efforts: opus },
            { ...model("claude-opus-4-6"), reasoning_efforts: ["low", "medium", "high", "max"] },
            { ...model("unsupported"), reasoning_efforts: [] },
        ];
        expect(modelEfforts(profile, catalogModel(rows, profile))).toEqual(opus);
        expect(modelEfforts(profile, catalogModel(rows, profile, "claude-opus-4-6"))).not.toContain("xhigh");
        expect(modelEfforts(profile, catalogModel(rows, profile, "unsupported"))).toEqual([]);
        expect(modelEfforts(profile, undefined)).toEqual(["low", "medium", "high"]);
    });
});

describe("모델 선택 목록 정렬", () => {
    it("버전을 숫자로 비교해 높은 버전부터 정렬하고 원본과 선택 정보를 보존한다", () => {
        const rows = [
            model("gpt-5.6"), model("gpt-5.10"),
            { ...model("gpt-6.1"), is_default: true, reasoning_efforts: ["high"] },
            model("gpt-6"), model("gpt-6.1-mini"),
        ];
        const sorted = sortModels(rows);
        expect(sorted.map((row) => row.id)).toEqual(["gpt-6.1", "gpt-6.1-mini", "gpt-6", "gpt-5.10", "gpt-5.6"]);
        expect(sorted[0]).toBe(rows[2]);
        expect(rows.map((row) => row.id)).toEqual(["gpt-5.6", "gpt-5.10", "gpt-6.1", "gpt-6", "gpt-6.1-mini"]);
    });

    it("모델 계열 이름보다 버전을 먼저 비교하고 버전 없는 모델은 뒤에 둔다", () => {
        const rows = [
            model("fable", "Fable 5.2"), model("sonnet", "Sonnet 5.5"),
            model("opus", "Opus 5.5"), model("haiku", "Haiku 5.5"),
            model("default", "Default"), model("custom", "Custom"),
        ];
        expect(sortModels(rows).map((row) => row.id)).toEqual(["haiku", "opus", "sonnet", "fable", "custom", "default"]);
    });

    it("표시 이름에 버전이 없으면 모델 ID를 사용하며 하이픈 버전도 숫자로 비교한다", () => {
        expect(sortModels([
            model("claude-opus-5-2", "Opus"), model("claude-opus-5-10", "Opus"),
            model("gpt-6.1", "GPT"), model("custom", "Custom"),
        ]).map((row) => row.id)).toEqual(["gpt-6.1", "claude-opus-5-10", "claude-opus-5-2", "custom"]);
        expect(sortModels([])).toEqual([]);
    });
});
