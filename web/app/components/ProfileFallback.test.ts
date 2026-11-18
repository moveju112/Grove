import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelProfile } from "../api/generated";
import { fallbackOptions, fallbackPayload, ProfileFallback } from "./ProfileFallback";

const profile = (id: string, protocol = "openai", enabled = true) => ({
    id, name: id, protocol, enabled, revision: 2, model: `model-${id}`, base_url: "http://127.0.0.1/v1", options: { timeout_secs: 30 },
}) as ModelProfile;

describe("명시적 HTTP fallback 설정", () => {
    const a = profile("a"), b = profile("b"), c = profile("c");
    it("기본 꺼짐이며 CLI에는 fallback 설정을 표시하지 않는다", () => {
        expect(fallbackOptions(a).enabled).toBe(false);
        expect(renderToStaticMarkup(createElement(ProfileFallback, { profile: a, profiles: [a, b] }))).toContain("꺼짐");
        expect(renderToStaticMarkup(createElement(ProfileFallback, { profile: profile("cli", "codex_cli"), profiles: [] }))).toBe("");
    });
    it("전송 확인과 revision을 포함하고 순서·기존 옵션을 보존한다", () => {
        const payload = fallbackPayload(a, [a, b, c], ["c", "b"], true);
        expect(payload.expected_revision).toBe(2);
        expect(payload.options).toEqual({ timeout_secs: 30, fallback: {
            enabled: true, destination_change_confirmed: true, candidates: [{ profile_id: "c", revision: 2 }, { profile_id: "b", revision: 2 }],
        } });
        expect(() => fallbackPayload(a, [b], ["b"], false)).toThrow("확인");
        expect(fallbackPayload(a, [b], [], false).options.fallback.enabled).toBe(false);
    });
    it("누락·비활성·CLI·중복·원래 모델과 무한 순서를 차단한다", () => {
        for (const ids of [["missing"], ["b", "b"], ["a"], ["b", "c", "d", "e", "f"]]) {
            expect(() => fallbackPayload(a, [a, b, c], ids, true)).toThrow();
        }
        for (const invalid of [profile("b", "openai", false), profile("b", "claude_code")]) {
            expect(() => fallbackPayload(a, [invalid], ["b"], true)).toThrow();
        }
    });
});
