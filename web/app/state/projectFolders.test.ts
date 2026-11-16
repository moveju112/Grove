import { describe, expect, it } from "vitest";
import type { Project, ProjectFolder } from "../api/generated";
import { groupProjects } from "./projectFolders";

const folder = (id: string) => ({ id, name: id } as ProjectFolder);
const project = (id: string, folder_id?: string) => ({ id, name: id, folder_id } as Project);

describe("프로젝트 정리용 폴더", () => {
    it("프로젝트 순서와 빈 폴더를 유지하고 폴더 밖 프로젝트를 따로 모은다", () => {
        const groups = groupProjects([project("pinned", "work"), project("plain"), project("next", "work")], [folder("work"), folder("empty")]);
        expect(groups.map((group) => [group.folder?.id ?? null, group.projects.map((p) => p.id)]))
            .toEqual([["work", ["pinned", "next"]], ["empty", []], [null, ["plain"]]]);
    });
    it("폴더 삭제·cache 갱신 사이에도 프로젝트를 목록에서 잃지 않는다", () => {
        const projects = [project("p", "deleted"), project("root")];
        expect(groupProjects(projects, [folder("other")]).at(-1)!.projects).toEqual(projects);
        expect(groupProjects(projects, []).at(-1)!.projects).toEqual(projects);
    });
});
