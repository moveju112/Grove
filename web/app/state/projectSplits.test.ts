import { describe, expect, it } from "vitest";
import * as L from "./layout";
import { activeProjectSplits, loadProjectSplits, placeProject, projectGeometry, projectIds } from "./projectSplits";

const target = (id: string) => ({ kind: "project" as const, project_id: id, resource_id: id, title: id });

describe("독립 프로젝트 배치의 분할", () => {
    it("가운데는 오른쪽에, 가장자리는 지정 방향에 프로젝트를 추가하고 중복은 옮긴다", () => {
        const a = activeProjectSplits(null, "a");
        const ab = placeProject(a, "a", target("b"), "center");
        expect(projectIds(ab)).toEqual(["a", "b"]);
        expect(ab.root).toMatchObject({ type: "split", direction: "row" });
        const ba = placeProject(ab, "a", target("b"), "top");
        expect(projectIds(ba)).toEqual(["b", "a"]);
        expect(ba.root).toMatchObject({ type: "split", direction: "column" });
        expect(placeProject(ba, "a", target("a"), "right")).toBe(ba);
        expect(L.isValid(ba)).toBe(true);
        expect(projectIds(a)).toEqual(["a"]);
    });
    it("그룹의 프로젝트 선택은 그룹을 보존하고 다른 프로젝트는 단독으로 연다", () => {
        const group = placeProject(activeProjectSplits(null, "a"), "a", target("b"), "right");
        expect(activeProjectSplits(group, "b")).toBe(group);
        expect(projectIds(activeProjectSplits(group, "a"))).toEqual(["a", "b"]);
        expect(projectIds(activeProjectSplits(group, "c"))).toEqual(["c"]);
    });
    it("닫기는 프로젝트 참조만 제거하며 남은 영역·포커스는 유효하다", () => {
        const group = placeProject(activeProjectSplits(null, "a"), "a", target("b"), "right");
        const next = L.closeTab(group, L.focusedLeaf(group).active_tab!);
        expect(projectIds(next)).toEqual(["a"]);
        expect(L.isValid(next)).toBe(true);
    });
    it("중첩 분할의 영역은 겹치지 않고 전체 화면을 정확히 채운다", () => {
        let layout = placeProject(activeProjectSplits(null, "a"), "a", target("b"), "right");
        layout = L.setRatio(layout, [], 0.6);
        layout = placeProject(layout, "b", target("c"), "bottom");
        const geometry = projectGeometry(layout);
        expect(geometry.panes).toEqual([
            { projectId: "a", rect: { x: 0, y: 0, width: 0.6, height: 1 } },
            { projectId: "b", rect: { x: 0.6, y: 0, width: 0.4, height: 0.5 } },
            { projectId: "c", rect: { x: 0.6, y: 0.5, width: 0.4, height: 0.5 } },
        ]);
        expect(geometry.panes.reduce((sum, pane) => sum + pane.rect.width * pane.rect.height, 0)).toBeCloseTo(1);
        expect(geometry.dividers.map((divider) => divider.path)).toEqual([[], [1]]);
    });
    it("한도에 이르면 새 프로젝트를 추가하지 않는다", () => {
        let layout = activeProjectSplits(null, "0");
        for (let i = 1; i < L.MAX_LEAVES; i++) {
            const leaf = L.leaves(layout.root).find((item) => L.canSplit(layout, item.id))!;
            layout = placeProject(layout, leaf.tabs[0]!.project_id!, target(String(i)), "right");
        }
        expect(placeProject(layout, "0", target("overflow"), "right")).toBe(layout);
        expect(L.isValid(layout)).toBe(true);
    });
    it("저장된 프로젝트 참조만 복원하고 중복 프로젝트·세션·손상된 배치는 무시한다", () => {
        const group = placeProject(activeProjectSplits(null, "a"), "a", target("b"), "right");
        expect(loadProjectSplits({ getItem: () => JSON.stringify(group) }, "pc")).toEqual(group);
        const mixed = L.openResource(group, { kind: "session", project_id: "b", resource_id: "s", title: "S" });
        expect(loadProjectSplits({ getItem: () => JSON.stringify(mixed) }, "pc")).toBeNull();
        // 별도 leaf ID를 가진 정상 트리라도 같은 프로젝트를 두 번 넣을 수 없다.
        const root = activeProjectSplits(null, "a");
        const repeated = L.splitLeaf(root, root.focused_leaf, "row", target("a"));
        expect(loadProjectSplits({ getItem: () => JSON.stringify(repeated) }, "pc")).toBeNull();
        expect(loadProjectSplits({ getItem: () => "{" }, "pc")).toBeNull();
    });
});
