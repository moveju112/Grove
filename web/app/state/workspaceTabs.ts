import * as L from "./layout";

export const workspaceResumeKey = "workspace-resume";
export const workspaceTabsKey = (projectId: string) => `workspace-tabs-${projectId}`;

type SessionTab = L.Tab & { project_id: string; resource_id: string };
const isSession = (tab: L.Tab): tab is SessionTab => tab.kind === "session" && !!tab.project_id && !!tab.resource_id;
const bySession = (layout: L.Layout) => new Map(L.allTabs(layout).filter(isSession).map((tab) => [tab.resource_id, tab]));
const activeSession = (layout: L.Layout): string | undefined => {
    const leaf = L.focusedLeaf(layout);
    return leaf.tabs.find((tab) => tab.id === leaf.active_tab && isSession(tab))?.resource_id;
};

function snapshot(tabs: SessionTab[], active?: string): L.Layout {
    const id = "workspace-tabs";
    return { schema: 1, focused_leaf: id, root: {
        type: "leaf", id, tabs, active_tab: tabs.find((tab) => tab.resource_id === active)?.id ?? tabs.at(-1)?.id ?? null,
    } };
}

export function workspaceTabs(layout: L.Layout): L.Layout {
    return snapshot([...bySession(layout).values()], activeSession(layout));
}

// 전체 스냅샷을 덮지 않고 이번 편집의 열기·닫기·선택만 최신 서버 탭에 적용한다.
export function mergeWorkspaceTabs(base: L.Layout, edited: L.Layout, current: L.Layout): L.Layout {
    const before = bySession(base);
    const after = bySession(edited);
    const tabs = bySession(current);
    let changed = false;
    for (const id of before.keys()) if (!after.has(id) && tabs.delete(id)) changed = true;
    for (const [id, tab] of after) {
        if (before.has(id) || tabs.has(id) || tabs.size >= L.MAX_TABS) continue;
        tabs.set(id, tab);
        changed = true;
    }
    const previous = activeSession(current);
    const active = activeSession(edited);
    const selected = active && tabs.has(active) && active !== activeSession(base) ? active : previous;
    return changed || selected !== previous ? snapshot([...tabs.values()], selected) : current;
}

// 기존 사본의 탭 ID·분할·파일·터미널을 보존한다. 공유 목록은 대화의 열림 여부만 정한다.
export function applyWorkspaceTabs(local: L.Layout, shared: L.Layout, resume: boolean): L.Layout {
    const tabs = bySession(shared);
    const active = L.focusedLeaf(local).active_tab;
    let next = local;
    for (const tab of L.allTabs(local)) {
        if (isSession(tab) && !tabs.has(tab.resource_id)) next = L.closeTab(next, tab.id);
    }
    const existing = bySession(next);
    const leaf = L.focusedLeaf(next).id;
    for (const [id, tab] of tabs) {
        if (!existing.has(id)) next = L.openTab(next, leaf, tab);
    }
    const selection = resume ? bySession(next).get(activeSession(shared) ?? "")?.id : undefined;
    if (selection) return L.focusedLeaf(next).active_tab === selection ? next : L.activate(next, selection);
    if (active && L.focusedLeaf(next).active_tab !== active && L.allTabs(next).some((tab) => tab.id === active)) return L.activate(next, active);
    return next;
}
