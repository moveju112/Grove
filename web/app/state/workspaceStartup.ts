import { api, authGeneration, isLoggedIn } from "../api/client";
import type { MessagePage, Project, Session, ToolCallRow, Turn } from "../api/generated";
import { conversationPagePath } from "./conversationPages";
import { layoutKey, loadPrefs } from "./device";
import { focusedLeaf } from "./layout";
import { readStoredLayout, type RemoteLayout } from "./layoutPersistence";
import { projectLayoutKey } from "./projectLayout";
import { readProjectSort, type ProjectSort } from "./projectOrder";
import { RECENT_PAGE_SIZE, readRecentRange, recentRangeKey } from "./recentQuery";
import { effectiveRecentWindow } from "./recentWindow";
import { subscribeQuery } from "./store";
import { workspaceResumeKey } from "./workspaceTabs";

export const selectionKey = (base: string) => `grove.layout.selected.${base}`;

function savedProject(base: string, storage: "sessionStorage" | "localStorage") {
    try {
        const id = window[storage].getItem(selectionKey(base));
        return id && /^[a-z0-9-]{1,64}$/i.test(id) ? id : null;
    } catch { return null; }
}

export function startupSelection(base: string) {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const reload = navigation?.type === "reload";
    // 같은 탭의 새로고침과 새 기기에서의 이어보기를 구분한다. 이전 버전에는 기기 사본만 있다.
    const project = (reload ? savedProject(base, "sessionStorage") : null) ?? savedProject(base, "localStorage");
    return { project, resumeShared: !(reload && project) };
}

export const getWorkspaceProjects = (sort: ProjectSort, signal?: AbortSignal) =>
    api.get<Project[]>(`/projects?sort=${sort === "recent" ? "recent" : "name"}`, signal ? { signal } : {});
export const readConversation = {
    messages: (id: string, signal?: AbortSignal) => api.get<MessagePage>(conversationPagePath(id), { signal }),
    turns: (id: string, signal?: AbortSignal) => api.get<Turn[]>(`/sessions/${id}/turns?limit=5`, { signal }),
    session: (id: string, signal?: AbortSignal) => api.get<Session>(`/sessions/${id}`, { signal }),
    calls: (id: string, signal?: AbortSignal) => api.get<ToolCallRow[]>(`/tool-calls?session_id=${id}&limit=200`, { signal }),
};

/// 대화 화면이 쓰는 조회를 기존 query cache로 먼저 시작한다. 배치 복원을 기다리지 않고 본문을 병행해 받는다.
/// 반환한 함수로 구독을 놓으면 받은 값은 cache에 남고, 그 사이 이벤트로 바뀐 항목만 화면이 열릴 때 다시 읽는다.
export function prefetchConversation(id: string, resources: (keyof typeof readConversation)[] = ["messages", "turns", "session", "calls"]): () => void {
    if (!/^[a-z0-9-]{1,64}$/i.test(id)) return () => undefined;
    const off = resources.map((resource) => subscribeQuery(`${resource}:${id}`, () => readConversation[resource](id), () => undefined));
    return () => off.forEach((release) => release());
}

let warm: { generation: number; resume: Promise<RemoteLayout> } | null = null;

// 로그인 직후 읽기만 시작한다. 초기 설정 확인 전에 배치를 적용하거나 편집하지 않는다.
export function primeWorkspaceStartup() {
    if (!isLoggedIn()) return;
    const { recentWindow, recentWindows } = loadPrefs();
    const range = effectiveRecentWindow(recentWindow, recentWindows);
    // 첫 목록을 먼저 받아 두되, 닫힌 모바일 서랍을 계속 구독하지는 않는다.
    subscribeQuery(recentRangeKey(range, RECENT_PAGE_SIZE), () => readRecentRange(range, RECENT_PAGE_SIZE), () => undefined)();
    const controller = new AbortController();
    let entry: typeof warm = null;
    const subscriptions: (() => void)[] = [];
    try {
        const base = layoutKey();
        const { project, resumeShared } = startupSelection(base);
        if (resumeShared) {
            const resume = getResume(controller.signal);
            entry = warm = { generation: authGeneration(), resume };
            void resume.catch(() => undefined);
        }
        if (project) {
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
