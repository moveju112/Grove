import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Requirements, RequirementContext } from "./Requirements";
import { SkillsPanel } from "../SkillsPanel";
import type { SkillEntry, SkillRequirements } from "../../../api/skills";

vi.mock("../../HelpTip", () => ({
    HelpTip: ({ label, children }: { label: string; children: ReactNode }) => createElement("aside", { "aria-label": label }, children),
    SentenceText: ({ text }: { text: string }) => text,
}));

const report: SkillRequirements = {
    declaration: { version: 1, tools: ["read"], platforms: ["linux"], skills: ["base"] },
    status: "blocked", problems: [{ code: "skill_dependency_unselected", message: "base를 먼저 명시적으로 선택하세요" }],
};
describe("스킬 요구사항", () => {
    it("선언과 실제 관측 이유를 텍스트로 표시한다", () => {
        const html = renderToStaticMarkup(createElement(Requirements, { report }));
        for (const text of ["read", "linux", "base", "불충족", "skill_dependency_unselected", "도구 실행은 기존 정책·승인을 따릅니다"]) expect(html).toContain(text);
        expect(renderToStaticMarkup(createElement(Requirements, { report: { ...report, status: "unknown" } }))).toContain("미확정");
        expect(renderToStaticMarkup(createElement(Requirements, { report: { declaration: null, status: "satisfied", problems: [] } }))).toContain("기존 동작 유지");
    });
    it("검증 조건은 전송 설정과 구분하며 미확정을 지원으로 추정하지 않는다", () => {
        const html = renderToStaticMarkup(createElement(RequirementContext, { value: {}, profiles: [], disabled: false, onChange: () => {} }));
        expect(html).toContain("입력창의 모델·도구 설정은 바꾸지 않습니다");
        expect(html).toContain("미확정");
    });
    it("불충족 후보는 본문을 보여줘도 선택 버튼을 막고 기존 해제는 보존한다", () => {
        const entry: SkillEntry = {
            id: "fixture", revision: "one", source: { kind: "global", root_id: "fixture" }, name: "review",
            enabled: true, symlink: false, alias_of: null, priority: "preferred", conflicts: [], metadata: "none", requirements: report,
        };
        const html = renderToStaticMarkup(createElement(SkillsPanel, {
            listing: { entries: [entry], issues: [] }, selected: [], preview: { selection: entry, text: "fixture", requirements: report },
            loading: false, onInspect: () => {}, onSelect: () => {}, onDeselect: () => {},
        }));
        expect(html.match(/<button(?=[^>]*aria-label="이 revision 선택 · 다음 모델 호출에 적용")[^>]*>/)?.[0]).toContain('disabled=""');
        const selected = renderToStaticMarkup(createElement(SkillsPanel, {
            listing: { entries: [entry], issues: [] }, selected: [entry], preview: null,
            loading: false, onInspect: () => {}, onSelect: () => {}, onDeselect: () => {},
        }));
        expect(selected).toContain("선택 해제");
    });
});
