import type { Project } from "../api/generated";
import { parseOpenTarget } from "./layout";

export const DRAG_PROJECT = "application/x-grove-project";
export const PROJECT_ORDER = "grove.layout.projectOrder";
export type ProjectSort = "name" | "recent" | "manual";
type Item = Pick<Project, "id" | "folder_id">;

export function parseProjectDrag(raw: string) {
    const target = parseOpenTarget(raw);
    return target?.kind === "project" && target.resource_id === target.project_id ? target : null;
}

export function loadProjectOrder(store: Pick<Storage, "getItem">): string[] {
    try {
        const value = JSON.parse(store.getItem(PROJECT_ORDER) ?? "[]");
        return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
    } catch { return []; }
}

export function orderProjects<T extends Item>(projects: readonly T[], order: readonly string[]): T[] {
    const positions = new Map(order.map((id, i) => [id, i]));
    return [...projects].sort((a, b) => (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length));
}

// 폴더 소속은 바꾸지 않는다. 필터로 가려진 프로젝트와 보관된 ID도 상대 순서를 보존한다.
export function moveProject(projects: readonly Item[], order: readonly string[], sourceId: string, targetId: string, after: boolean): string[] {
    const source = projects.find((project) => project.id === sourceId);
    const target = projects.find((project) => project.id === targetId);
    if (!source || !target || sourceId === targetId || (source.folder_id ?? null) !== (target.folder_id ?? null)) return [...order];
    const ids = [...new Set([...order, ...projects.map((project) => project.id)])].filter((id) => id !== sourceId);
    ids.splice(ids.indexOf(targetId) + Number(after), 0, sourceId);
    return ids;
}
