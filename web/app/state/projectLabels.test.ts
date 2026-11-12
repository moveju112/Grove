import { describe, expect, it } from "vitest";
import type { Label, Project } from "../api/generated";
import { filterProjects, UNLABELLED } from "./projectLabels";

const p = (id: string, labels: string[]) => ({ id, labels }) as unknown as Project;
const l = (id: string) => ({ id }) as unknown as Label;

describe("filterProjects", () => {
    const projects = [p("a", ["x"]), p("b", []), p("c", ["x", "y"])];
    const labels = [l("x"), l("y")];
    const ids = (v: Project[]) => v.map((x) => x.id);

    it("선택이 없으면 전부", () => expect(ids(filterProjects(projects, [], labels))).toEqual(["a", "b", "c"]));
    it("선택한 라벨 중 하나라도 붙은 프로젝트", () => expect(ids(filterProjects(projects, ["y"], labels))).toEqual(["c"]));
    it("라벨 없음은 다른 선택과 함께 쓸 수 있다", () => expect(ids(filterProjects(projects, ["y", UNLABELLED], labels))).toEqual(["b", "c"]));
    it("삭제된 라벨만 남은 선택은 필터하지 않는다", () => expect(ids(filterProjects(projects, ["gone"], labels))).toEqual(["a", "b", "c"]));
});
