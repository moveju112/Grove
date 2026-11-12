import { describe, expect, it } from "vitest";
import {
    allTabs, closeLeaf, closeTab, emptyLayout, fileTarget, focusedLeaf, isValid, leaves, markMissing, mobileView, moveTab, openResource, openTab, setDirection, setRatio, splitLeaf,
    type Layout,
} from "./layout";

const sA = { kind: "session" as const, project_id: "A", resource_id: "sa", title: "A 대화" };
const sB = { kind: "session" as const, project_id: "B", resource_id: "sb", title: "B 대화" };

function twoPanes(dir: "row" | "column" = "row"): Layout {
    let l = emptyLayout();
    l = openTab(l, l.focused_leaf, sA);
    l = splitLeaf(l, l.focused_leaf, dir, sB);
    return l;
}

describe("layout", () => {
    it("다른 pane의 열린 자원으로 이동하고 모바일에서도 그 탭을 표시한다", () => {
        const l = twoPanes();
        const original = leaves(l.root)[0]!.tabs[0]!;
        const next = openResource(l, sA);
        expect(allTabs(next)).toHaveLength(2);
        expect(focusedLeaf(next).active_tab).toBe(original.id);
        expect(mobileView(next).tab?.id).toBe(original.id);
        const opened = openResource(next, { ...sA, resource_id: "new" });
        expect(allTabs(opened)).toHaveLength(3);
        expect(focusedLeaf(opened).id).toBe(focusedLeaf(next).id);
    });
    it("이미 여러 사본이 있으면 현재 pane의 사본을 유지하며 명시적인 분할은 새 사본을 만든다", () => {
        let l = emptyLayout();
        l = openTab(l, l.focused_leaf, sA);
        l = splitLeaf(l, l.focused_leaf, "row", sA);
        const copy = focusedLeaf(l);
        const next = openResource(l, sA);
        expect(focusedLeaf(next).id).toBe(copy.id);
        expect(focusedLeaf(next).active_tab).toBe(copy.active_tab);
        expect(allTabs(next)).toHaveLength(2);
        expect(allTabs(splitLeaf(next, copy.id, "column", sA))).toHaveLength(3);
    });
    it("프로젝트와 파일/줄 정규화에 맞는 대상만 재사용한다", () => {
        let l = emptyLayout();
        const file = { kind: "file" as const, project_id: "A", resource_id: "src/a:42", title: "src/a:42" };
        l = openTab(l, l.focused_leaf, file);
        const original = focusedLeaf(l).tabs[0]!.id;
        l = splitLeaf(l, l.focused_leaf, "row", sB);
        l = openResource(l, { ...file, resource_id: "src/a", filePath: "src/a", fileLine: 42 });
        expect(allTabs(l)).toHaveLength(2);
        expect(focusedLeaf(l).active_tab).toBe(original);
        l = openResource(l, { ...file, filePath: "src/a:42" });
        expect(allTabs(l)).toHaveLength(3);
        l = openResource(l, { ...sB, project_id: "A" });
        expect(allTabs(l)).toHaveLength(4);
    });
    it("파일 경로와 줄 번호를 구분하고 이전 배치와 같은 대상은 중복 생성하지 않는다", () => {
        let l = emptyLayout();
        const old = { kind: "file" as const, project_id: "A", resource_id: "src/a.txt:42", title: "src/a.txt:42" };
        l = openTab(l, l.focused_leaf, old);
        l = openTab(l, l.focused_leaf, { ...old, resource_id: "src/a.txt", filePath: "src/a.txt", fileLine: 42 });
        expect(allTabs(l)).toHaveLength(1);
        const literal = { ...old, filePath: "src/a.txt:42" };
        l = openTab(l, l.focused_leaf, literal);
        expect(allTabs(l)).toHaveLength(2);
        expect(fileTarget(literal)).toEqual({ path: "src/a.txt:42", line: undefined });
        expect(fileTarget({ resource_id: "files", title: "파일 · A" })).toBeNull();
        expect(fileTarget({ resource_id: "files", filePath: "files", title: "files" })?.path).toBe("files");
    });
    it("opens a resource once per pane", () => {
        let l = emptyLayout();
        l = openTab(l, l.focused_leaf, sA);
        l = openTab(l, l.focused_leaf, sA);
        expect(allTabs(l)).toHaveLength(1);
    });

    it("splits left/right and top/bottom with each tab bound to its project", () => {
        const l = twoPanes("row");
        expect(l.root.type).toBe("split");
        expect(leaves(l.root).map((x) => x.tabs[0]!.project_id)).toEqual(["A", "B"]);
        expect(focusedLeaf(l).tabs[0]!.project_id).toBe("B");
        const c = setDirection(l, [], "column");
        expect(c.root.type === "split" && c.root.direction).toBe("column");
        expect(isValid(c)).toBe(true);
    });

    it("clamps ratio", () => {
        const l = setRatio(twoPanes(), [], 0.99);
        expect(l.root.type === "split" && l.root.ratio).toBe(0.9);
        expect(isValid(l)).toBe(true);
    });

    it("moves a tab across panes and collapses the empty pane", () => {
        const l = twoPanes();
        const tabB = leaves(l.root)[1]!.tabs[0]!;
        const target = leaves(l.root)[0]!.id;
        const m = moveTab(l, tabB.id, target);
        expect(leaves(m.root)).toHaveLength(1);
        expect(allTabs(m).map((t) => t.project_id)).toEqual(["A", "B"]);
        expect(isValid(m)).toBe(true);
    });

    it("closing a pane merges tabs instead of losing them", () => {
        const l = twoPanes();
        const right = leaves(l.root)[1]!.id;
        const c = closeLeaf(l, right);
        expect(leaves(c.root)).toHaveLength(1);
        expect(allTabs(c)).toHaveLength(2);
    });

    it("closing last tab keeps one empty pane", () => {
        let l = emptyLayout();
        l = openTab(l, l.focused_leaf, sA);
        const c = closeTab(l, allTabs(l)[0]!.id);
        expect(leaves(c.root)).toHaveLength(1);
        expect(allTabs(c)).toHaveLength(0);
        expect(isValid(c)).toBe(true);
    });

    it("rejects malformed saved layouts", () => {
        expect(isValid({ schema: 2 })).toBe(false);
        const l = twoPanes();
        const broken = JSON.parse(JSON.stringify(l));
        broken.root.children[1].tabs[0].project_id = undefined;
        expect(isValid(broken)).toBe(false);
        const dup = JSON.parse(JSON.stringify(l));
        dup.root.children[1].id = dup.root.children[0].id;
        expect(isValid(dup)).toBe(false);
        expect(isValid(JSON.parse(JSON.stringify(l)))).toBe(true);
    });

    it("marks missing resources without dropping tabs and keeps hidden pane state on mobile", () => {
        const l = twoPanes();
        const missing = markMissing(l, (t) => t.project_id !== "B");
        expect(missing.size).toBe(1);
        expect(allTabs(l)).toHaveLength(2);
        const v = mobileView(l);
        expect(v.tab?.project_id).toBe("B");
    });

    it("limits pane count", () => {
        let l = emptyLayout();
        l = openTab(l, l.focused_leaf, sA);
        for (let i = 0; i < 40; i++) l = splitLeaf(l, leaves(l.root)[0]!.id, i % 2 ? "row" : "column", { ...sA, resource_id: "x" + i });
        expect(leaves(l.root).length).toBeLessThanOrEqual(16);
        expect(isValid(l)).toBe(true);
    });
});
