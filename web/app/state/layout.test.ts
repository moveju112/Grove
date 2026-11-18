import { describe, expect, it } from "vitest";
import {
    allTabs, closeLeaf, closeTab, emptyLayout, fileTarget, focusedLeaf, isValid, leaves, markMissing, MAX_LEAVES, mobileView, moveTab, openAtEdge, openResource, openTab,
    parseOpenTarget, placeTab, replaceTab, setDirection, setRatio, splitLeaf, tabTitle,
    type Layout, type Node,
} from "./layout";

const sA = { kind: "session" as const, project_id: "A", resource_id: "sa", title: "A 대화" };
const sB = { kind: "session" as const, project_id: "B", resource_id: "sb", title: "B 대화" };

describe("탭 표시 제목", () => {
    it("프로젝트명으로 저장된 첫 탭과 새 입력 탭을 모두 새 대화로 표시한다", () => {
        for (const resource_id of ["A", undefined]) {
            const tab = { id: "project", kind: "project" as const, project_id: "A", resource_id, title: "프로젝트 이름" };
            expect(tabTitle(tab)).toBe("새 대화");
            expect(tab.title).toBe("프로젝트 이름");
            expect(tab.resource_id).toBe(resource_id);
        }
    });
    it("기존 대화·파일·터미널·설정의 제목은 유지한다", () => {
        for (const kind of ["session", "file", "terminal", "settings"] as const) {
            expect(tabTitle({ kind, title: "원래 제목" })).toBe("원래 제목");
        }
    });
});

function twoPanes(dir: "row" | "column" = "row"): Layout {
    let l = emptyLayout();
    l = openTab(l, l.focused_leaf, sA);
    l = splitLeaf(l, l.focused_leaf, dir, sB);
    return l;
}

function shares(node: Node, direction: "row" | "column", size = 1): number[] {
    if (node.type !== "split" || node.direction !== direction) return [size];
    return [...shares(node.children[0], direction, size * node.ratio), ...shares(node.children[1], direction, size * (1 - node.ratio))];
}

describe("탭 drag/drop·메뉴 이동", () => {
    const sC = { kind: "session" as const, project_id: "A", resource_id: "sc", title: "C 대화" };

    it.each([["row", "right"], ["column", "bottom"]] as const)("%s 끝에 추가할 때 2~5개 영역을 균등하게 나눈다", (direction, edge) => {
        let l = emptyLayout();
        l = openTab(l, l.focused_leaf, sA);
        for (let count = 2; count <= 5; count++) {
            l = openAtEdge(l, l.focused_leaf, edge, { ...sB, resource_id: `s${count}` });
            const sizes = shares(l.root, direction);
            expect(sizes).toHaveLength(count);
            for (const size of sizes) expect(size).toBeCloseTo(1 / count, 10);
            expect(isValid(l)).toBe(true);
        }
    });

    it("탭을 가장자리로 옮기면 빈 영역을 닫은 뒤 남은 영역을 균등하게 나눈다", () => {
        const pair = twoPanes();
        const three = openAtEdge(pair, pair.focused_leaf, "right", sC);
        const [left, , right] = leaves(three.root);
        const tab = left!.tabs[0]!;
        const moved = placeTab(three, tab.id, right!.id, "right");
        expect(allTabs(moved).map((t) => t.resource_id)).toEqual(["sb", "sc", "sa"]);
        expect(focusedLeaf(moved).active_tab).toBe(tab.id);
        for (const size of shares(moved.root, "row")) expect(size).toBeCloseTo(1 / 3, 10);
    });

    it("반대 방향으로 나뉜 영역의 내부 비율은 유지한다", () => {
        const pair = setRatio(twoPanes("column"), [], 0.35);
        const first = openAtEdge(pair, pair.focused_leaf, "left", sC);
        const next = openAtEdge(first, first.focused_leaf, "left", { ...sC, resource_id: "sd" });
        expect(next.root).toMatchObject({ type: "split", direction: "column", ratio: 0.35 });
        if (next.root.type !== "split") throw new Error("Expected a column split");
        for (const size of shares(next.root.children[1], "row")) expect(size).toBeCloseTo(1 / 3, 10);
    });
    it("같은 pane 안에서 순서를 바꾸고 tab ID를 유지한다", () => {
        let l = emptyLayout();
        for (const t of [sA, sB, sC]) l = openTab(l, l.focused_leaf, t);
        const [a, b, c] = leaves(l.root)[0]!.tabs;
        const next = placeTab(l, a!.id, l.focused_leaf, "center", 1);
        expect(leaves(next.root)[0]!.tabs.map((t) => t.id)).toEqual([b!.id, a!.id, c!.id]);
        expect(placeTab(next, c!.id, l.focused_leaf, "center", 0).root).toMatchObject({ tabs: [c, b, a].map((t) => ({ id: t!.id })) });
        expect(validAfter(placeTab(l, a!.id, l.focused_leaf, "center", 99))).toBe(true);
    });
    it("다른 pane의 지정 위치로 옮기고 빈 pane은 정리한다", () => {
        const l = twoPanes();
        const [left, right] = leaves(l.root);
        const moved = placeTab(l, left!.tabs[0]!.id, right!.id, "center", 0);
        expect(leaves(moved.root)).toHaveLength(1);
        expect(leaves(moved.root)[0]!.tabs.map((t) => t.resource_id)).toEqual(["sa", "sb"]);
        expect(leaves(moved.root)[0]!.active_tab).toBe(left!.tabs[0]!.id);
    });
    it("가장자리 drop은 그 방향에 새 pane을 만들고 원래 pane이 비면 닫는다", () => {
        const l = twoPanes();
        const [left, right] = leaves(l.root);
        const top = placeTab(l, right!.tabs[0]!.id, left!.id, "top");
        expect(leaves(top.root).map((x) => x.tabs.map((t) => t.resource_id))).toEqual([["sb"], ["sa"]]);
        expect(top.root).toMatchObject({ type: "split", direction: "column" });
        expect(focusedLeaf(top).tabs[0]!.id).toBe(right!.tabs[0]!.id);
        let one = emptyLayout();
        one = openTab(openTab(one, one.focused_leaf, sA), one.focused_leaf, sB);
        const split = placeTab(one, leaves(one.root)[0]!.tabs[0]!.id, one.focused_leaf, "right");
        expect(leaves(split.root).map((x) => x.tabs.map((t) => t.resource_id))).toEqual([["sb"], ["sa"]]);
    });
    it("자기 pane의 유일한 탭 분할·한도 초과는 배치를 바꾸지 않는다", () => {
        let l = emptyLayout();
        l = openTab(l, l.focused_leaf, sA);
        const only = leaves(l.root)[0]!.tabs[0]!.id;
        expect(placeTab(l, only, l.focused_leaf, "left")).toBe(l);
        let n = 0;
        while (leaves(l.root).length < MAX_LEAVES) {
            for (const leaf of leaves(l.root)) l = splitLeaf(l, leaf.id, "row", { ...sB, resource_id: `s${n++}` });
        }
        expect(leaves(l.root)).toHaveLength(MAX_LEAVES);
        expect(openAtEdge(l, l.focused_leaf, "right", sC)).toBe(l);
        const extra = leaves(l.root)[0]!;
        const full = openTab(l, extra.id, sC);
        expect(placeTab(full, focusedLeaf(full).tabs.at(-1)!.id, extra.id, "bottom")).toBe(full);
    });
    it("최근 항목 drop은 가운데면 같은 자원을 재사용하고 가장자리면 새 pane에 연다", () => {
        const l = twoPanes();
        const [left] = leaves(l.root);
        expect(allTabs(openAtEdge(l, left!.id, "center", sA))).toHaveLength(2);
        const below = openAtEdge(l, left!.id, "bottom", sC);
        expect(leaves(below.root).map((x) => x.tabs.map((t) => t.resource_id))).toEqual([["sa"], ["sc"], ["sb"]]);
        expect(focusedLeaf(below).tabs[0]!.resource_id).toBe("sc");
    });
    it("drag 데이터는 형식·ID·길이를 검증한다", () => {
        expect(parseOpenTarget(JSON.stringify(sA))).toEqual(sA);
        expect(parseOpenTarget(JSON.stringify({ kind: "file", project_id: "A", resource_id: "src/a b.ts", filePath: "src/a b.ts", title: "a" }))).toMatchObject({ filePath: "src/a b.ts" });
        for (const bad of [
            "{broken", "null", JSON.stringify({ ...sA, kind: "settings" }), JSON.stringify({ ...sA, project_id: "../x" }),
            JSON.stringify({ ...sA, resource_id: "a/b" }), JSON.stringify({ ...sA, title: "x".repeat(501) }), JSON.stringify({ ...sA, filePath: "x" }),
        ]) expect(parseOpenTarget(bad)).toBeNull();
    });
});

function validAfter(l: Layout) {
    return isValid(l);
}

describe("layout", () => {
    it("새 대화는 같은 프로젝트에서도 별도 탭으로 열고 전송 후 같은 탭을 세션으로 바꾼다", () => {
        let l = emptyLayout();
        const draft = { kind: "project" as const, project_id: "A", title: "새 대화" };
        l = openTab(l, l.focused_leaf, draft);
        const first = focusedLeaf(l).active_tab!;
        l = openTab(l, l.focused_leaf, draft);
        const second = focusedLeaf(l).active_tab!;
        expect(allTabs(l)).toHaveLength(2);
        expect(first).not.toBe(second);
        const next = replaceTab(l, first, sA);
        expect(allTabs(next)).toEqual([{ ...sA, id: first }, { ...draft, id: second }]);
        expect(focusedLeaf(next).active_tab).toBe(second);
        expect(isValid(next)).toBe(true);
        expect(replaceTab(next, "closed-tab", sA)).toBe(next);
    });

    it("새 대화 분할은 기존 세션을 복사하지 않고 선택한 방향에 빈 입력 탭을 만든다", () => {
        for (const [edge, direction] of [["right", "row"], ["bottom", "column"]] as const) {
            let l = emptyLayout();
            l = openTab(l, l.focused_leaf, sA);
            const original = focusedLeaf(l);
            const next = openAtEdge(l, original.id, edge, { kind: "project", project_id: "A", title: "새 대화" });
            expect(next.root).toMatchObject({ type: "split", direction });
            expect(leaves(next.root)[0]).toEqual(original);
            expect(focusedLeaf(next).tabs).toEqual([expect.objectContaining({ kind: "project", project_id: "A", title: "새 대화" })]);
            expect(focusedLeaf(next).tabs[0]!.resource_id).toBeUndefined();
            expect(allTabs(next).filter((tab) => tab.resource_id === sA.resource_id)).toHaveLength(1);
            expect(isValid(next)).toBe(true);
        }
    });

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

    it("중첩 pane은 인접 영역에 합치고 활성 탭·독립 사본 ID·다른 분할 비율을 보존한다", () => {
        let l = twoPanes();
        const right = focusedLeaf(l).id;
        l = splitLeaf(l, right, "column", sB);
        const closing = focusedLeaf(l).id;
        l = openTab(l, closing, { ...sA, resource_id: "other" });
        const selected = focusedLeaf(l).active_tab;
        const ids = allTabs(l).map((t) => t.id).sort();
        l = setRatio(l, [], 0.35);
        const next = closeLeaf(l, closing);
        expect(next.focused_leaf).toBe(right);
        expect(focusedLeaf(next).active_tab).toBe(selected);
        expect(focusedLeaf(next).tabs).toHaveLength(3);
        expect(allTabs(next).map((t) => t.id).sort()).toEqual(ids);
        expect(leaves(next.root)[0]).toEqual(leaves(l.root)[0]);
        expect(next.root.type === "split" && next.root.ratio).toBe(0.35);
        expect(isValid(next)).toBe(true);
    });

    it.each([["column", "row", "right"], ["row", "column", "bottom"]] as const)(
        "%s 아래의 오른쪽/아래쪽 영역을 닫으면 %s 방향만 균등하게 다시 나눈다", (outer, inner, edge) => {
            const pair = setRatio(twoPanes(outer), [], 0.35);
            const [first, second] = leaves(pair.root);
            const fill = (layout: Layout, id: string) => {
                for (let i = 0; i < 3; i++) {
                    layout = openAtEdge(layout, id, edge, sA);
                    id = layout.focused_leaf;
                }
                return layout;
            };
            const grid = fill(fill(pair, first!.id), second!.id);
            const panes = leaves(grid.root);
            expect(panes).toHaveLength(8);
            const next = closeLeaf(closeTab(grid, panes[3]!.tabs[0]!.id), panes[7]!.id);
            expect(leaves(next.root)).toHaveLength(6);
            expect(allTabs(next)).toHaveLength(7);
            expect(next.root).toMatchObject({ type: "split", direction: outer, ratio: 0.35 });
            if (next.root.type !== "split") throw new Error("Expected a split");
            for (const child of next.root.children) {
                const sizes = shares(child, inner);
                expect(sizes).toHaveLength(3);
                for (const size of sizes) expect(size).toBeCloseTo(1 / 3, 10);
            }
        },
    );

    it("영역이 남는 탭 닫기는 비율을 보존하고 같은 축에서 첫 영역까지 닫으면 다시 균등하게 나눈다", () => {
        const pair = twoPanes();
        const three = openAtEdge(pair, pair.focused_leaf, "right", sA);
        const first = leaves(three.root)[0]!;
        const adjusted = setRatio(three, [1], 0.7);
        const withExtra = openTab(adjusted, first.id, sB);
        const tabOnly = closeTab(withExtra, leaves(withExtra.root)[0]!.tabs[1]!.id);
        expect(shares(tabOnly.root, "row")).toEqual(shares(adjusted.root, "row"));
        expect(shares(closeTab(tabOnly, first.tabs[0]!.id).root, "row")).toEqual([0.5, 0.5]);
    });

    it("빈 pane도 안전하게 합치고 마지막 pane 또는 없는 대상은 그대로 둔다", () => {
        const base = openTab(emptyLayout(), "missing", sA);
        expect(closeLeaf(base, base.focused_leaf)).toBe(base);
        expect(closeLeaf(base, "missing")).toBe(base);
        const pair = twoPanes();
        const l = splitLeaf(pair, focusedLeaf(pair).id, "row");
        const next = closeLeaf(l, focusedLeaf(l).id);
        expect(leaves(next.root)).toHaveLength(2);
        expect(allTabs(next)).toEqual(allTabs(pair));
        expect(isValid(next)).toBe(true);
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
