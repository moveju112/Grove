import { describe, expect, it } from "vitest";
import * as L from "./layout";
import { projectLayout, projectLayoutKey } from "./projectLayout";

const legacy: L.Layout = { schema: 1, focused_leaf: "right", root: {
    type: "split", direction: "column", ratio: 0.65, children: [
        { type: "leaf", id: "left", active_tab: "b", tabs: [
            { id: "a1", kind: "session", project_id: "A", resource_id: "a", title: "A" },
            { id: "b", kind: "session", project_id: "B", resource_id: "b", title: "B" },
        ] },
        { type: "leaf", id: "right", active_tab: "a2", tabs: [
            { id: "a2", kind: "session", project_id: "A", resource_id: "a", title: "A 사본" },
            { id: "settings", kind: "settings", project_id: "A", title: "설정" },
        ] },
    ],
} };

describe("프로젝트별 배치 이관", () => {
    it("탭 ID·독립 사본·분할 방향·비율·포커스를 유지하고 다른 프로젝트와 설정을 제외한다", () => {
        const before = structuredClone(legacy);
        const a = projectLayout(legacy, "A");
        expect(L.isValid(a)).toBe(true);
        expect(L.allTabs(a).map((tab) => tab.id)).toEqual(["a1", "a2"]);
        expect(a.root).toMatchObject({ type: "split", direction: "column", ratio: 0.65 });
        expect(a.focused_leaf).toBe("right");
        expect(L.findLeaf(a, "left")?.active_tab).toBe("a1");
        expect(projectLayout(a, "A")).toEqual(a);
        expect(legacy).toEqual(before);
    });
    it("다른 프로젝트만 있던 pane을 제거하고 유효한 포커스·빈 배치를 남긴다", () => {
        const b = projectLayout(legacy, "B");
        expect(b.root).toMatchObject({ type: "leaf", id: "left", active_tab: "b" });
        expect(b.focused_leaf).toBe("left");
        expect(L.isValid(b)).toBe(true);
        const empty = projectLayout(legacy, "C");
        expect(L.allTabs(empty)).toEqual([]);
        expect(L.isValid(empty)).toBe(true);
    });
    it("한 프로젝트의 닫기·분할 변경이 다른 프로젝트나 이관 원본을 바꾸지 않는다", () => {
        const a = projectLayout(legacy, "A");
        const b = projectLayout(legacy, "B");
        const before = structuredClone(b);
        expect(L.allTabs(L.closeTab(a, "a2")).map((tab) => tab.id)).toEqual(["a1"]);
        expect(b).toEqual(before);
        expect(L.allTabs(legacy)).toHaveLength(4);
    });
    it("기기·프로젝트·화면 폭별 키는 서로 다르고 64자 서버 계약을 지킨다", () => {
        const keys = [
            projectLayoutKey("d", "A"), projectLayoutKey("d", "B"),
            projectLayoutKey("d-narrow", "A"), projectLayoutKey("e", "A"),
            projectLayoutKey("d".repeat(64), "p".repeat(128)),
        ];
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.every((key) => /^[A-Za-z0-9_-]{1,64}$/.test(key))).toBe(true);
        expect(keys[0]).toBe(projectLayoutKey("d", "A"));
        expect(keys[2]?.endsWith("-narrow")).toBe(true);
    });
});
