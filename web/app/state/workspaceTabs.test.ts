import { describe, expect, it } from "vitest";
import * as L from "./layout";
import { applyWorkspaceTabs, mergeWorkspaceTabs, workspaceTabs } from "./workspaceTabs";

const tab = (id: string, kind: L.TabKind = "session"): L.Tab =>
    ({ id, kind, resource_id: id, project_id: "project", title: id });
const open = (layout: L.Layout, id: string) => L.openTab(layout, layout.focused_leaf, tab(id));
const ids = (layout: L.Layout) => L.allTabs(layout).map((item) => item.resource_id);

describe("공유 대화 탭", () => {
    it("동시에 서로 다른 대화를 열고 닫아도 상대의 변경을 덮지 않는다", () => {
        const base = workspaceTabs(open(open(L.emptyLayout(), "A"), "B"));
        const phone = workspaceTabs(open(L.closeTab(base, "A"), "C"));
        const desktop = workspaceTabs(open(L.closeTab(base, "B"), "D"));
        const merged = mergeWorkspaceTabs(base, phone, desktop);
        expect(ids(merged)).toEqual(["D", "C"]);
        expect(L.focusedLeaf(merged).active_tab).toBe("C");
    });

    it("다른 기기의 대화를 추가해도 현재 파일, 기존 탭 ID, 분할 비율은 유지한다", () => {
        const initial = open(L.emptyLayout(), "A");
        const desktop = L.splitLeaf(initial, initial.focused_leaf, "row", tab("file", "file"));
        const shared = workspaceTabs(open(initial, "B"));
        const projected = applyWorkspaceTabs(desktop, shared, false);
        expect(projected.root.type).toBe("split");
        expect(projected.root.type === "split" && projected.root.ratio).toBe(0.5);
        expect(L.focusedLeaf(projected).active_tab).toBe("file");
        expect(L.allTabs(projected).map((item) => item.id)).toEqual(["A", "file", "B"]);
        expect(L.focusedLeaf(applyWorkspaceTabs(projected, shared, true)).active_tab).toBe("B");
        expect(mergeWorkspaceTabs(initial, desktop, shared)).toBe(shared);
    });

    it("한 대화의 여러 로컬 사본을 보존하고 공유 목록에서 닫히면 모두 제거한다", () => {
        const first = open(L.emptyLayout(), "A");
        const copy = { ...tab("A"), id: "local-copy" };
        const duplicate = L.splitLeaf(first, first.focused_leaf, "row", copy);
        const shared = workspaceTabs(duplicate);
        expect(ids(shared)).toEqual(["A"]);
        expect(applyWorkspaceTabs(duplicate, shared, false)).toBe(duplicate);
        expect(ids(applyWorkspaceTabs(duplicate, workspaceTabs(L.emptyLayout()), false))).toEqual([]);
    });
});
