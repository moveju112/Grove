import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableModel, ModelProfile } from "../api/generated";
import { catalogModel, latestModels, modelEfforts, prefetchProfiles, readRecentProfiles, rememberRecentProfile, RECENT_PROFILES_KEY, sortModels } from "./model-catalog";

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

describe("계열별 최신 모델", () => {
    const latest = (rows: AvailableModel[], keep: string[] = []) => latestModels(sortModels(rows), keep).map((row) => row.id);

    it("CLI 목록에서 계열마다 가장 높은 버전만 남긴다", () => {
        const claude = [
            model("claude-fable-5", "Fable 5"), model("claude-fable-5-1", "Fable 5.1"), model("claude-haiku-4-5-20251001", "Haiku 4.5"),
            model("claude-opus-4-7", "Opus 4.7"), model("claude-opus-5", "Opus 5"), model("claude-sonnet-4-6", "Sonnet 4.6"),
            model("fable", "Fable 5.2"), model("haiku", "Haiku 5.5"), model("opus", "Opus 5.5"), model("sonnet", "Sonnet 5.5"),
        ];
        expect(latest(claude)).toEqual(["haiku", "opus", "sonnet", "fable"]);
        // 이름의 구분자가 공백이어도 같은 계열이다.
        const codex = [
            model("gpt-5.6-luna", "GPT-5.6-Luna"), model("gpt-5.6-terra", "GPT-5.6-Terra"), model("gpt-6-luna", "GPT-6-Luna"),
            model("gpt-6-sol", "GPT-6-Sol"), model("gpt-6.1-terra", "GPT-6.1 Terra"), model("gpt-6.2-astra", "GPT-6.2-Astra"),
            model("gpt-6-astra", "GPT-6-Astra"), { ...model("gpt-6.2-sol", "GPT-6.2-Sol"), is_default: true },
        ];
        expect(latest(codex)).toEqual(["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"]);
    });

    it("날짜 고정본은 별칭과 같은 계열로 보고, 버전을 모르는 모델·기본 모델·지정한 모델은 남긴다", () => {
        const rows = [
            model("gpt-4o-2024-05-13"), model("gpt-4o-2024-08-06"), model("gpt-4o"), model("gpt-4-0613"),
            model("gpt-4.1"), model("gpt-5"), { ...model("o1"), is_default: true }, model("o3"),
            model("claude-opus-5-2", "Opus"), model("claude-opus-5-10", "Opus"), model("custom", "Custom"),
        ];
        expect(latest(rows, ["gpt-4.1"])).toEqual(["claude-opus-5-10", "gpt-5", "gpt-4.1", "gpt-4o", "o3", "o1", "custom"]);
        expect(latestModels([model("gpt-4o-2024-05-13"), model("gpt-4o-2024-08-06")]).map((row) => row.id)).toEqual(["gpt-4o-2024-08-06"]);
        expect(latestModels([])).toEqual([]);
    });
});

describe("모델 목록 미리 조회 대상", () => {
    const profile = (id: string, enabled = true) => ({ id, enabled }) as ModelProfile;
    const profiles = [profile("a"), profile("b"), profile("c", false), profile("d"), profile("e")];
    afterEach(() => vi.unstubAllGlobals());

    it("최근 사용 → 즐겨찾기 순으로 현재·꺼진·중복 프로필을 빼고 상한까지만 고른다", () => {
        expect(prefetchProfiles(profiles, "a", ["a", "c", "d", "missing"], ["d", "b", "e"]).map((p) => p.id)).toEqual(["d", "b", "e"]);
        expect(prefetchProfiles(profiles, null, [], ["e", "b"], 1).map((p) => p.id)).toEqual(["e"]);
    });

    it("최근 고른 프로필을 앞에 두고 4개까지 기기에 기억한다", () => {
        const store = new Map<string, string>([[RECENT_PROFILES_KEY, JSON.stringify(["x", "y", "z", "w"])]]);
        vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
        rememberRecentProfile("z");
        expect(readRecentProfiles()).toEqual(["z", "x", "y", "w"]);
        rememberRecentProfile("n");
        expect(readRecentProfiles()).toEqual(["n", "z", "x", "y"]);
        store.set(RECENT_PROFILES_KEY, "{broken");
        expect(readRecentProfiles()).toEqual([]);
    });
});
