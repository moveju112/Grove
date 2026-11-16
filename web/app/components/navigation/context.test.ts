import { describe, expect, it } from "vitest";
import type { Project, Session } from "../../api/generated";
import * as L from "../../state/layout";
import { navigationContext, projectTarget, resourceLabel } from "./context";

const projects = [{ id: "a", name: "같은 이름" }, { id: "b", name: "같은 이름" }] as Project[];
const session = { id: "sa", project_id: "a", title: "서버에서 바뀐 제목" } as Session;
const a: L.Tab = { id: "ta", kind: "session", project_id: "a", resource_id: "sa", title: "오래된 제목" };
const b: L.Tab = { id: "tb", kind: "session", project_id: "b", resource_id: "sb", title: "오래된 제목" };
const layout: L.Layout = { schema: 1, focused_leaf: "left", root: {
    type: "split", direction: "row", ratio: 0.6, children: [
        { type: "leaf", id: "left", active_tab: a.id, tabs: [a] },
        { type: "leaf", id: "right", active_tab: b.id, tabs: [b] },
    ],
} };

describe("실제 활성 pane·tab의 위치", () => {
    it("제목이 같아도 현재 ID로 프로젝트·세션을 구분한다", () => {
        const context = navigationContext(layout, projects, session);
        expect(context).toMatchObject({ tab: a, project: projects[0], projectId: "a", sessionId: "sa", session, pane: 1, panes: 2 });
        expect(navigationContext(L.focus(layout, "right"), projects, session)).toMatchObject({
            tab: b, project: projects[1], projectId: "b", sessionId: "sb", session: undefined, pane: 2,
        });
    });
    it("이전 프로젝트의 늦은 응답이나 다른 프로젝트 소속 세션은 사용하지 않는다", () => {
        expect(navigationContext(layout, projects, { ...session, project_id: "b" }).session).toBeUndefined();
        expect(navigationContext(L.focus(layout, "right"), projects, session).session).toBeUndefined();
    });
    it("활성 탭 변경·전역 설정·빈 영역은 이전 세션 맥락을 남기지 않는다", () => {
        const settings = L.openResource(layout, { kind: "settings", title: "설정" });
        expect(navigationContext(settings, projects, session)).toMatchObject({ projectId: undefined, sessionId: undefined, session: undefined });
        expect(navigationContext(L.emptyLayout(), projects, session)).toMatchObject({ tab: undefined, session: undefined, pane: 1, panes: 1 });
        expect(navigationContext(undefined, projects, session)).toEqual({ pane: 0, panes: 0 });
        expect(navigationContext(L.activate(settings, a.id), projects, session).session).toBe(session);
    });
    it("프로젝트·세션 설정은 layout에 명시된 부모만 제공한다", () => {
        const scoped = L.openResource(layout, { kind: "settings", project_id: "a", resource_id: "session:sa", title: "잘못된 표시 제목" });
        const context = navigationContext(scoped, projects, session);
        expect(context).toMatchObject({ projectId: "a", sessionId: "sa", session });
        expect(projectTarget(context)).toEqual({ kind: "project", project_id: "a", resource_id: "a", title: projects[0]!.name });
        const projectSettings = L.openResource(layout, { kind: "settings", project_id: "b", resource_id: "settings", title: "설정" });
        expect(navigationContext(projectSettings, projects, session).sessionId).toBeUndefined();
    });
    it("목록에서 사라져도 ID를 보존하고 다른 프로젝트 이름으로 추정하지 않는다", () => {
        const context = navigationContext(layout, [], undefined);
        expect(projectTarget(context)).toEqual({ kind: "project", project_id: "a", resource_id: "a", title: "프로젝트 a" });
        expect(context.sessionId).toBe("sa");
    });
    it("부모 열기는 기존 열기 계약으로 탭 ID·다른 pane·원본 배치를 보존한다", () => {
        const before = structuredClone(layout);
        const target = projectTarget(navigationContext(layout, projects))!;
        const next = L.openResource(layout, target);
        expect(layout).toEqual(before);
        expect(L.allTabs(next).filter((t) => t.kind === "session")).toEqual([a, b]);
        expect(L.findLeaf(next, "right")).toBe(L.findLeaf(layout, "right"));
        expect(L.focusedLeaf(next).tabs).toContainEqual(a);
        expect(L.allTabs(L.openResource(next, target))).toEqual(L.allTabs(next));
    });
    it("폭별 배치는 전달된 layout만 읽으며 숨긴 배치의 응답을 채택하지 않는다", () => {
        const narrow = L.focus(layout, "right");
        expect(navigationContext(narrow, projects, session).sessionId).toBe("sb");
        expect(navigationContext(layout, projects, session).sessionId).toBe("sa");
    });
    it("파일 경로·터미널과 설정의 종류를 구분한다", () => {
        expect(resourceLabel({ ...a, kind: "file", filePath: "src/main.ts", title: "오래된 경로" })).toBe("파일 · src/main.ts");
        expect(resourceLabel({ ...a, kind: "terminal", title: "터미널 1" })).toBe("터미널 · 터미널 1");
        expect(resourceLabel({ ...a, kind: "settings" })).toBe("설정");
    });
});
