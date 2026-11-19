import { api, authGeneration, isLoggedIn } from "../api/client";
import type { MessagePage, Project, Session, ToolCallRow, Turn } from "../api/generated";
import { layoutKey } from "./device";
import { focusedLeaf } from "./layout";
import { readStoredLayout, type RemoteLayout } from "./layoutPersistence";
import { projectLayoutKey } from "./projectLayout";
import { readProjectSort, type ProjectSort } from "./projectOrder";
import { subscribeQuery } from "./store";
import { workspaceResumeKey } from "./workspaceTabs";

export const selectionKey = (base: string) => `grove.layout.selected.${base}`;
export const getWorkspaceProjects = (sort: ProjectSort, signal?: AbortSignal) =>
    api.get<Project[]>(`/projects?sort=${sort === "recent" ? "recent" : "name"}`, signal ? { signal } : {});
export const readConversation = {
    messages: (id: string, signal?: AbortSignal) => api.get<MessagePage>(`/sessions/${id}/messages?limit=100`, { signal }),
    turns: (id: string, signal?: AbortSignal) => api.get<Turn[]>(`/sessions/${id}/turns?limit=5`, { signal }),
    session: (id: string, signal?: AbortSignal) => api.get<Session>(`/sessions/${id}`, { signal }),
    calls: (id: string, signal?: AbortSignal) => api.get<ToolCallRow[]>(`/tool-calls?session_id=${id}&limit=200`, { signal }),
};

let warm: { generation: number; resume: Promise<RemoteLayout> } | null = null;

// 로그인 직후 읽기만 시작한다. 초기 설정 확인 전에 배치를 적용하거나 편집하지 않는다.
export function primeWorkspaceStartup() {
    if (!isLoggedIn()) return;
    const controller = new AbortController();
    const resume = getResume(controller.signal);
    const entry = warm = { generation: authGeneration(), resume };
    void resume.catch(() => undefined);
    const subscriptions: (() => void)[] = [];
    try {
        const base = layoutKey();
        const project = localStorage.getItem(selectionKey(base));
        if (project && /^[a-z0-9-]{1,64}$/i.test(project)) {
            const layout = readStoredLayout(localStorage, projectLayoutKey(base, project));
            const leaf = layout && focusedLeaf(layout);
            const tab = leaf && leaf.tabs.find((item) => item.id === leaf.active_tab && item.kind === "session" && item.project_id === project);
            const id = tab?.resource_id;
            if (id && /^[a-z0-9-]{1,64}$/i.test(id)) {
                for (const [resource, get] of Object.entries(readConversation)) {
                    subscriptions.push(subscribeQuery(`${resource}:${id}`, () => get(id, controller.signal), () => undefined));
                }
            }
            subscriptions.push(subscribeQuery(`project:${project}`, () => api.get<Project>(`/projects/${project}`, { signal: controller.signal }), () => undefined));
        }
        const sort = readProjectSort(localStorage);
        subscriptions.push(subscribeQuery(`projects:${sort}`, () => getWorkspaceProjects(sort, controller.signal), () => undefined));
    } catch { /* 로컬 선택이 없거나 저장소 접근이 막히면 복원 경로에서 확인한다. */ }
    return () => {
        if (warm === entry) warm = null;
        subscriptions.forEach((off) => off());
        controller.abort();
    };
}

const getResume = (signal: AbortSignal) => api.get<RemoteLayout>(`/layouts/${workspaceResumeKey}`, { signal, timeoutMs: 10_000 });

export function readWorkspaceResume(signal: AbortSignal) {
    const ready = warm;
    warm = null;
    return ready?.generation === authGeneration() ? ready.resume : getResume(signal);
}
