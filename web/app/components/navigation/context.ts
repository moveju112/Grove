import type { Project, Session } from "../../api/generated";
import { fileTarget, leaves, mobileView, type Layout, type Tab } from "../../state/layout";

export type NavigationContext = {
    tab?: Tab;
    project?: Project;
    projectId?: string;
    sessionId?: string;
    session?: Session;
    pane: number;
    panes: number;
};

// 표시 이름이나 응답 도착 순서가 아닌 현재 배치의 ID로만 위치를 결정한다.
export function navigationContext(layout: Layout | undefined, projects: Project[], session?: Session): NavigationContext {
    if (!layout) return { pane: 0, panes: 0 };
    const { leaf, tab } = mobileView(layout);
    const all = leaves(layout.root);
    const projectId = tab?.project_id;
    const sessionId = tab?.kind === "session" ? tab.resource_id
        : tab?.kind === "settings" && tab.resource_id?.startsWith("session:") ? tab.resource_id.slice(8) || undefined : undefined;
    return {
        tab, projectId, sessionId,
        project: projects.find((p) => p.id === projectId),
        session: session && session.id === sessionId && session.project_id === projectId ? session : undefined,
        pane: all.findIndex((p) => p.id === leaf.id) + 1,
        panes: all.length,
    };
}

export function resourceLabel(tab: Tab): string {
    switch (tab.kind) {
        case "settings": return "설정";
        case "file": return `파일 · ${fileTarget(tab)?.path ?? "파일 탐색기"}`;
        case "terminal": return `터미널 · ${tab.title || tab.resource_id || "터미널"}`;
        case "project": return "프로젝트";
        case "session": return "세션";
    }
}

export function projectTarget(context: NavigationContext): Omit<Tab, "id"> | undefined {
    return context.projectId ? {
        kind: "project", project_id: context.projectId, resource_id: context.projectId,
        title: context.project?.name ?? `프로젝트 ${context.projectId}`,
    } : undefined;
}
