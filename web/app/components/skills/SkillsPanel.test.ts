import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillsPanel, type SkillsPanelProps } from "./SkillsPanel";
import { bindingOf, sameSelection, selectionStatus, type SkillEntry } from "./types";
import { Button } from "../../design/Button";

vi.mock("../HelpTip", () => ({
    HelpTip: ({ label, children }: { label: string; children: ReactNode }) => createElement("aside", { "aria-label": label }, children),
    SentenceText: ({ text }: { text: string }) => text,
}));
vi.mock("../ui/Controls", () => ({
    DetailDialog: ({ title, children }: { title: ReactNode; children: ReactNode }) => createElement("section", null, title, children),
}));

const entry: SkillEntry = {
    id: "skill_safe", name: "review", source: { kind: "global", root_id: "global" },
    revision: "a".repeat(64), symlink: false, alias_of: null, priority: "preferred",
    conflicts: [], metadata: "none",
    enabled: true,
};
const selection = bindingOf(entry);
const props: SkillsPanelProps = {
    listing: { entries: [entry], issues: [] }, selected: [], preview: { selection, text: "<script>unsafe()</script>" },
    loading: false, onInspect: () => {}, onSelect: () => {}, onDeselect: () => {},
};
const render = (changes: Partial<SkillsPanelProps> = {}) => renderToStaticMarkup(createElement(SkillsPanel, { ...props, ...changes }));

type ElementProps = {
    children?: ReactNode; label?: ReactNode; startContent?: ReactNode; endContent?: ReactNode;
    onClick?: () => void; disabled?: boolean; "aria-label"?: string;
};
function buttons(node: ReactNode): ElementProps[] {
    const found: ElementProps[] = [];
    Children.forEach(node, (child) => {
        if (!isValidElement<ElementProps>(child)) return;
        if (child.type === "button" || child.type === Button) found.push(child.props);
        for (const content of [child.props.children, child.props.label, child.props.startContent, child.props.endContent]) {
            found.push(...buttons(content));
        }
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
        expect(html).toContain("선택됨");
        expect(html).toContain("자동 매칭 없음");
        expect(html).toContain("선택 해제");
    });
    it("비활성 본문은 관측·편집할 수 있지만 모델 선택은 막는다", () => {
        const disabled = { ...entry, enabled: false };
        const toggled: unknown[] = [];
        const edited: unknown[] = [];
        const controls = buttons(SkillsPanel({
            ...props, listing: { entries: [disabled], issues: [] },
            onSetEnabled: (binding, enabled) => toggled.push({ binding, enabled }),
            onEdit: (body) => edited.push(body),
        }));
        expect(controls.find((button) => button.children === "이 스킬 사용")!.disabled).toBe(true);
        controls.find((button) => button.children === "활성화")!.onClick!();
        controls.find((button) => button.children === "본문 편집")!.onClick!();
        expect(toggled).toEqual([{ binding: selection, enabled: true }]);
        expect(edited).toEqual([props.preview]);
        expect(render({ listing: { entries: [disabled], issues: [] } })).toContain("비활성 · 모델 적용 불가");
    });
    it("로딩·오류·stale 본문은 표시하거나 선택에 재사용하지 않는다", () => {
        expect(render({ loading: true })).not.toContain("unsafe()");
        expect(render({ error: "조회 실패" })).not.toContain("unsafe()");
        expect(render({ error: "조회 실패" })).toContain('role="alert"');
        const html = render({ preview: { selection: { ...selection, revision: "old" }, text: "STALE_BODY" } });
        expect(html).not.toContain("STALE_BODY");
        expect(html).toContain("본문의 출처·revision이 목록과 달라");
        expect(html).not.toContain("이 스킬 사용");
    });
    it("목록에서 사라진 선택과 바뀐 revision은 보존하며 명시적으로 해제한다", () => {
        const stale = render({ selected: [{ ...selection, revision: "old" }] });
        expect(stale).toContain("다시 확인 필요");
        const orphaned = render({ listing: { entries: [], issues: [] }, selected: [selection], preview: null });
        expect(orphaned).toContain("목록에서 사라진 선택이 있으며 자동 대체하지 않습니다");
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
        controls.find((button) => button.children === "이 스킬 사용")!.onClick!();
        expect(inspected).toEqual([selection]);
        expect(chosen).toEqual([selection]);
        const prior = { ...selection, revision: "old" };
        buttons(SkillsPanel({ ...wired, selected: [prior] })).find((button) => button.children === "선택 해제")!.onClick!();
        expect(removed).toEqual([prior]);
    });
    it("동명 항목·alias·stale 선택이 있으면 자동 대체를 위한 선택을 허용하지 않는다", () => {
        const other: SkillEntry = { ...entry, id: "other", source: { kind: "project", root_id: "project", project_id: "p" } };
        const selectDisabled = (changes: Partial<SkillsPanelProps>) => buttons(SkillsPanel({ ...props, ...changes }))
            .find((button) => button.children === "이 스킬 사용")!.disabled;
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
