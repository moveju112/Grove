import { describe, expect, it } from "vitest";
import {
    allTabs, closeLeaf, closeTab, emptyLayout, focusedLeaf, isValid, leaves, markMissing, mobileView, moveTab, openTab, setDirection, setRatio, splitLeaf,
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
