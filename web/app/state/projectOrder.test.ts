import { describe, expect, it } from "vitest";
import { loadProjectOrder, moveProject, orderProjects, parseProjectDrag } from "./projectOrder";

const projects = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("프로젝트 순서 드래그", () => {
    it("위·아래 이동 후 전체 순서를 유지하며 원본을 바꾸지 않는다", () => {
        const first = moveProject(projects, [], "d", "b", false);
        expect(first).toEqual(["a", "d", "b", "c"]);
        expect(moveProject(projects, first, "d", "c", true)).toEqual(["a", "b", "c", "d"]);
        expect(projects.map((project) => project.id)).toEqual(["a", "b", "c", "d"]);
    });
    it("필터 밖 프로젝트·보관된 ID는 버리지 않고 새 프로젝트는 끝에 붙인다", () => {
        const order = moveProject(projects, ["a", "archived", "b", "c", "d"], "d", "b", false);
        expect(order).toEqual(["a", "archived", "d", "b", "c"]);
        expect(orderProjects([...projects, { id: "new" }], order).map((p) => p.id)).toEqual(["a", "d", "b", "c", "new"]);
    });
    it("자기 자신·없는 프로젝트·다른 폴더로의 드롭은 소속과 순서를 바꾸지 않는다", () => {
        const all = [...projects, { id: "folder", folder_id: "f" }];
        for (const [source, target] of [["a", "a"], ["missing", "a"], ["a", "missing"], ["a", "folder"]]) {
            expect(moveProject(all, ["a", "b"], source!, target!, false)).toEqual(["a", "b"]);
        }
    });
    it("저장 순서는 중복 ID만 정리하고 손상된 사본은 무시한다", () => {
        expect(loadProjectOrder({ getItem: () => '["a","a",3,"b"]' })).toEqual(["a", "b"]);
        expect(loadProjectOrder({ getItem: () => "{" })).toEqual([]);
    });
    it("다른 종류·경로·불일치 ID를 가진 외부 drag는 프로젝트로 해석하지 않는다", () => {
        const target = { kind: "project", project_id: "a", resource_id: "a", title: "A" };
        expect(parseProjectDrag(JSON.stringify(target))).toEqual(target);
        for (const value of [{ ...target, kind: "session" }, { ...target, resource_id: "b" }, { ...target, project_id: "../x" }]) {
            expect(parseProjectDrag(JSON.stringify(value))).toBeNull();
        }
    });
});
