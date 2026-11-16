import type { Project, ProjectFolder } from "../api/generated";

// 폴더·프로젝트 snapshot이 서로 다른 순간에 갱신돼도 프로젝트를 목록에서 잃지 않는다.
export function groupProjects(projects: readonly Project[], folders: readonly ProjectFolder[]) {
    const known = new Set(folders.map((folder) => folder.id));
    return [
        ...folders.map((folder) => ({ folder, projects: projects.filter((project) => project.folder_id === folder.id) })),
        { folder: null, projects: projects.filter((project) => !project.folder_id || !known.has(project.folder_id)) },
    ];
}
