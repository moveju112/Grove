import { api, authGeneration, isLoggedIn } from "../api/client";
import type { FileContent, FileRead } from "../api/generated";
export type { FileContent } from "../api/generated";
type Listener = { value: (content: FileContent) => void; error: (error: unknown) => void };
type Watch = {
    projectId: string; path: string; owner: number; listeners: Set<Listener>;
    controller: AbortController; timer?: ReturnType<typeof setTimeout>; busy: boolean; again: boolean; force: boolean; content?: FileContent;
};
const watches = new Map<string, Watch>();
const active = (watch: Watch) => watch.listeners.size > 0 && watch.owner === authGeneration() && isLoggedIn() && document.visibilityState !== "hidden";

async function refresh(watch: Watch, force = false) {
    if (!active(watch)) return;
    if (watch.busy) { watch.again = true; watch.force ||= force; return; }
    if (watch.timer) clearTimeout(watch.timer);
    watch.busy = true;
    const stamp = !force && !watch.force ? watch.content?.stamp : undefined;
    watch.force = false;
    try {
        const result = await api.get<FileRead>(`/projects/${watch.projectId}/files/content?path=${encodeURIComponent(watch.path)}${stamp ? `&known_stamp=${encodeURIComponent(stamp)}` : ""}`,
            { signal: watch.controller.signal, timeoutMs: 10_000 });
        // known_stamp는 원문을 가지고 있을 때만 전송한다.
        const content = "unchanged" in result ? watch.content! : result;
        watch.content = content;
        if (active(watch) && !watch.again) for (const listener of watch.listeners) listener.value(content);
    } catch (error) {
        if (active(watch) && !watch.again) for (const listener of watch.listeners) listener.error(error);
    } finally {
        watch.busy = false;
        if (active(watch)) {
            const delay = watch.again ? 0 : 5000;
            watch.again = false;
            watch.timer = setTimeout(() => void refresh(watch), delay);
        }
    }
}

export function refreshFiles(projectId?: string) {
    for (const watch of watches.values()) if (!projectId || watch.projectId === projectId) void refresh(watch, true);
}
const focus = () => refreshFiles();
const visibility = () => {
    for (const watch of watches.values()) {
        if (document.visibilityState === "hidden") {
            if (watch.timer) clearTimeout(watch.timer);
        } else void refresh(watch, true);
    }
};

// 인증 API를 쓰는 공유 구독이다. 서버 이벤트/창 복귀는 즉시, 외부 편집은 5초마다 확인한다.
export function watchFile(projectId: string, path: string, listener: Listener, initial?: FileContent): () => void {
    const key = JSON.stringify([projectId, path]);
    let watch = watches.get(key);
    if (!watch) {
        watch = { projectId, path, owner: authGeneration(), listeners: new Set(), controller: new AbortController(), busy: false, again: false, force: false, content: initial };
        if (watches.size === 0) {
            window.addEventListener("focus", focus);
            document.addEventListener("visibilitychange", visibility);
        }
        watches.set(key, watch);
    }
    watch.listeners.add(listener);
    // 현재 진행 중인 첫 조회는 기존/새 구독자 모두에게 전달하므로 중복 요청하지 않는다.
    if (!watch.busy) void refresh(watch);
    const own = watch;
    return () => {
        if (!own.listeners.delete(listener)) return;
        if (own.listeners.size > 0) return;
        if (own.timer) clearTimeout(own.timer);
        own.controller.abort();
        watches.delete(key);
        if (watches.size === 0) {
            window.removeEventListener("focus", focus);
            document.removeEventListener("visibilitychange", visibility);
        }
    };
}
