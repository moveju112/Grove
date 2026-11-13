import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillsPanel, type SkillsPanelProps } from "./SkillsPanel";
import { bindingOf, sameSelection, selectionStatus, type SkillEntry } from "./types";

const entry: SkillEntry = {
    id: "skill_safe", name: "review", source: { kind: "global", root_id: "global" },
    revision: "a".repeat(64), symlink: false, alias_of: null, priority: "preferred",
    conflicts: [], metadata: "none",
};
const selection = bindingOf(entry);
const props: SkillsPanelProps = {
    listing: { entries: [entry], issues: [] }, selected: [], preview: { selection, text: "<script>unsafe()</script>" },
    loading: false, onInspect: () => {}, onSelect: () => {}, onDeselect: () => {},
};
const render = (changes: Partial<SkillsPanelProps> = {}) => renderToStaticMarkup(createElement(SkillsPanel, { ...props, ...changes }));

type ElementProps = { children?: ReactNode; onClick?: () => void; disabled?: boolean; "aria-label"?: string };
function buttons(node: ReactNode): ElementProps[] {
    const found: ElementProps[] = [];
    Children.forEach(node, (child) => {
        if (!isValidElement<ElementProps>(child)) return;
        if (child.type === "button") found.push(child.props);
        found.push(...buttons(child.props.children));
    });
    return found;
}

describe("스킬 조회·명시적 선택", () => {
    it("선택은 ID·출처·revision 전체에 결합한다", () => {
        expect(sameSelection(selection, { ...selection })).toBe(true);
        expect(sameSelection(selection, { ...selection, revision: "b".repeat(64) })).toBe(false);
        expect(sameSelection(selection, { ...selection, source: { kind: "project", root_id: "global", project_id: "p" } })).toBe(false);
        expect(selectionStatus(entry, [])).toBe("none");
        expect(selectionStatus(entry, [selection])).toBe("selected");
        expect(selectionStatus(entry, [{ ...selection, revision: "old" }])).toBe("stale");
        const copy = bindingOf(entry);
        copy.source.root_id = "changed";
        expect(entry.source.root_id).toBe("global");
    });
    it("원문 HTML은 실행하지 않고 명시적 선택·모델 적용 규칙을 표시한다", () => {
        const html = render({ selected: [selection] });
        expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
        expect(html).not.toContain("<script>");
        expect(html).toContain("선택됨 · 다음 모델 호출 직전 재검증");
        expect(html).toContain("자동 매칭 없음");
        expect(html).toContain("선택 해제");
    });
    it("로딩·오류·stale 본문은 표시하거나 선택에 재사용하지 않는다", () => {
        expect(render({ loading: true })).not.toContain("unsafe()");
        expect(render({ error: "조회 실패" })).not.toContain("unsafe()");
        expect(render({ error: "조회 실패" })).toContain('role="alert"');
        const html = render({ preview: { selection: { ...selection, revision: "old" }, text: "STALE_BODY" } });
        expect(html).not.toContain("STALE_BODY");
        expect(html).toContain("현재 목록과 다릅니다");
        expect(html).not.toContain("이 revision 선택");
    });
    it("목록에서 사라진 선택과 바뀐 revision은 보존하며 명시적으로 해제한다", () => {
        const stale = render({ selected: [{ ...selection, revision: "old" }] });
        expect(stale).toContain("다시 확인 필요");
        const orphaned = render({ listing: { entries: [], issues: [] }, selected: [selection], preview: null });
        expect(orphaned).toContain("현재 목록에서 확인되지 않는 선택");
        expect(orphaned).toContain("이 선택 해제");
    });
    it("우선순위·동명 충돌·alias·미해석 metadata와 부분 실패를 표시한다", () => {
        const html = render({
            listing: {
                entries: [{ ...entry, priority: "conflict", conflicts: ["another"], symlink: true, alias_of: "another", metadata: "opaque_front_matter" }],
                issues: [{ source: entry.source, name: "blocked", code: "skill_forbidden" }],
            },
        });
        expect(html).toContain("동일 우선순위 충돌");
        expect(html).toContain("내부 symlink");
        expect(html).toContain("alias");
        expect(html).toContain("front matter는 원문");
        expect(html).toContain("skill_forbidden");
    });
    it("조회·선택·해제 callback에는 표시한 revision의 binding을 전달한다", () => {
        const inspected: unknown[] = [];
        const chosen: unknown[] = [];
        const removed: unknown[] = [];
        const wired: SkillsPanelProps = {
            ...props, onInspect: (value) => inspected.push(value), onSelect: (value) => chosen.push(value),
            onDeselect: (value) => removed.push(value),
        };
        const controls = buttons(SkillsPanel(wired));
        controls.find((button) => button["aria-label"]?.endsWith("본문 보기"))!.onClick!();
        controls.find((button) => button.children === "이 revision 선택 · 다음 모델 호출에 적용")!.onClick!();
        expect(inspected).toEqual([selection]);
        expect(chosen).toEqual([selection]);
        const prior = { ...selection, revision: "old" };
        buttons(SkillsPanel({ ...wired, selected: [prior] })).find((button) => button.children === "선택 해제")!.onClick!();
        expect(removed).toEqual([prior]);
    });
    it("동명 항목·alias·stale 선택이 있으면 자동 대체를 위한 선택을 허용하지 않는다", () => {
        const other: SkillEntry = { ...entry, id: "other", source: { kind: "project", root_id: "project", project_id: "p" } };
        const selectDisabled = (changes: Partial<SkillsPanelProps>) => buttons(SkillsPanel({ ...props, ...changes }))
            .find((button) => button.children === "이 revision 선택 · 다음 모델 호출에 적용")!.disabled;
        expect(selectDisabled({})).toBe(false);
        expect(selectDisabled({ selected: [selection] })).toBe(true);
        expect(selectDisabled({ selected: [{ ...selection, revision: "old" }] })).toBe(true);
        expect(selectDisabled({ selected: [{ ...selection, id: "removed" }] })).toBe(true);
        expect(selectDisabled({ busy: true })).toBe(true);
        expect(selectDisabled({ listing: { entries: [entry, other], issues: [] }, selected: [bindingOf(other)] })).toBe(true);
        const alias: SkillEntry = { ...entry, id: "alias", name: "alias", symlink: true, alias_of: entry.id };
        expect(selectDisabled({ listing: { entries: [entry, alias], issues: [] }, selected: [bindingOf(alias)] })).toBe(true);
        expect(render({ listing: { entries: [{ ...entry, priority: "incomplete" }], issues: [] } })).toContain("우선순위 미확정");
    });
});
