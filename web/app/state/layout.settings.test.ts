import { describe, expect, it } from "vitest";
import { allTabs, isValid, withoutSettingsTabs, type Layout } from "./layout";

describe("설정 창으로 바뀐 이전 탭 복원", () => {
    it("작업 탭과 ID는 유지하고 설정만 있던 영역은 정리한다", () => {
        const layout: Layout = { schema: 1, focused_leaf: "settings-pane", root: {
            type: "split", direction: "row", ratio: 0.5, children: [
                { type: "leaf", id: "work", active_tab: "settings-a", tabs: [
                    { id: "chat", kind: "session", project_id: "p", resource_id: "s", title: "대화" },
                    { id: "settings-a", kind: "settings", title: "설정" },
                ] },
                { type: "leaf", id: "settings-pane", active_tab: "settings-b", tabs: [
                    { id: "settings-b", kind: "settings", project_id: "p", title: "프로젝트 설정" },
                ] },
            ],
        } };
        const original = structuredClone(layout);
        const restored = withoutSettingsTabs(layout);
        expect(layout).toEqual(original);
        expect(isValid(restored)).toBe(true);
        expect(restored.root).toMatchObject({ type: "leaf", id: "work", active_tab: "chat" });
        expect(restored.focused_leaf).toBe("work");
        expect(allTabs(restored)).toEqual([allTabs(layout)[0]]);
        expect(withoutSettingsTabs(restored)).toBe(restored);
    });

    it("설정만 열려 있었으면 유효한 빈 작업 영역을 남긴다", () => {
        const layout: Layout = { schema: 1, focused_leaf: "pane", root: {
            type: "leaf", id: "pane", active_tab: "settings", tabs: [{ id: "settings", kind: "settings", title: "설정" }],
        } };
        const restored = withoutSettingsTabs(layout);
        expect(isValid(restored)).toBe(true);
        expect(restored.root).toEqual({ type: "leaf", id: "pane", active_tab: null, tabs: [] });
    });
});
