import * as L from "./layout";

export const projectSplitsKey = (base: string) => `grove.layout.projectSplits.${base}`;
export const projectIds = (layout: L.Layout) => L.allTabs(layout).flatMap((tab) => tab.project_id ? [tab.project_id] : []);

export function loadProjectSplits(store: Pick<Storage, "getItem">, base: string): L.Layout | null {
    try {
        const layout = JSON.parse(store.getItem(projectSplitsKey(base)) ?? "null");
        if (!L.isValid(layout)) return null;
        const ids = projectIds(layout);
        return L.leaves(layout.root).every((leaf) => leaf.tabs.length === 1 && leaf.tabs[0]?.kind === "project"
            && leaf.tabs[0].resource_id === leaf.tabs[0].project_id) && new Set(ids).size === ids.length ? layout : null;
    } catch { return null; }
}

export function activeProjectSplits(saved: L.Layout | null | undefined, projectId?: string | null): L.Layout {
    if (!projectId) return L.emptyLayout();
    const tab = saved && L.allTabs(saved).find((item) => item.project_id === projectId);
    if (saved && tab) return L.focusedLeaf(saved).active_tab === tab.id ? saved : L.activate(saved, tab.id);
    return L.openResource(L.emptyLayout(), { kind: "project", project_id: projectId, resource_id: projectId, title: projectId });
}

export function placeProject(layout: L.Layout, sourceId: string, target: Omit<L.Tab, "id">, edge: L.DropEdge): L.Layout {
    const leaf = L.leaves(layout.root).find((item) => item.tabs[0]?.project_id === sourceId);
    if (!leaf || !target.project_id || sourceId === target.project_id) return layout;
    const existing = L.allTabs(layout).find((tab) => tab.project_id === target.project_id);
    if (existing) return edge === "center" ? L.activate(layout, existing.id) : L.placeTab(layout, existing.id, leaf.id, edge);
    return L.openAtEdge(layout, leaf.id, edge === "center" ? "right" : edge, target);
}

export type Rect = { x: number; y: number; width: number; height: number };
export type ProjectDivider = { rect: Rect; path: number[]; direction: "row" | "column"; ratio: number };

// 프로젝트별 DOM을 재배치하지 않고 영역만 바꾼다. 분할 전후에도 입력·선택·스크롤 수명이 같다.
export function projectGeometry(layout: L.Layout) {
    const panes: { projectId: string; rect: Rect }[] = [];
    const dividers: ProjectDivider[] = [];
    const walk = (node: L.Node, rect: Rect, path: number[]) => {
        if (node.type === "leaf") {
            const projectId = node.tabs[0]?.project_id;
            if (projectId) panes.push({ projectId, rect });
            return;
        }
        dividers.push({ rect, path, direction: node.direction, ratio: node.ratio });
        const a = { ...rect }, b = { ...rect };
        if (node.direction === "row") {
            a.width *= node.ratio;
            b.x += a.width; b.width -= a.width;
        } else {
            a.height *= node.ratio;
            b.y += a.height; b.height -= a.height;
        }
        walk(node.children[0], a, [...path, 0]);
        walk(node.children[1], b, [...path, 1]);
    };
    walk(layout.root, { x: 0, y: 0, width: 1, height: 1 }, []);
    return { panes, dividers };
}
