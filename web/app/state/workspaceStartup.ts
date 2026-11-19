import { api, authGeneration, isLoggedIn } from "../api/client";
import type { Project } from "../api/generated";
import { layoutKey } from "./device";
import type { RemoteLayout } from "./layoutPersistence";
import { readProjectSort, type ProjectSort } from "./projectOrder";
import { subscribeQuery } from "./store";
import { workspaceResumeKey } from "./workspaceTabs";

export const selectionKey = (base: string) => `grove.layout.selected.${base}`;
export const getWorkspaceProjects = (sort: ProjectSort, signal?: AbortSignal) =>
    api.get<Project[]>(`/projects?sort=${sort === "recent" ? "recent" : "name"}`, signal ? { signal } : {});

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
        const sort = readProjectSort(localStorage);
        subscriptions.push(subscribeQuery(`projects:${sort}`, () => getWorkspaceProjects(sort, controller.signal), () => undefined));
        const project = localStorage.getItem(selectionKey(layoutKey()));
        if (project && /^[a-z0-9-]{1,64}$/i.test(project)) {
            subscriptions.push(subscribeQuery(`project:${project}`, () => api.get<Project>(`/projects/${project}`, { signal: controller.signal }), () => undefined));
        }
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
