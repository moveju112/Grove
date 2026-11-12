import type { Store } from "./drafts";

export type FileBuffer = {
    text: string | null;
    base: string | null;
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
    top: number;
    left: number;
};
export type FileAttempt = { method: "post" | "put"; path: string; body: Record<string, string | null>; key: string };

const scope = (project: string, path: string, copy: string) => JSON.stringify([project, path, copy]);
const bufferKey = (project: string, path: string, copy: string) => `grove.file.buffer.${scope(project, path, copy)}`;
export const fileAttemptKey = (project: string, path: string, copy: string, kind = "content") => `grove.file.attempt.${JSON.stringify([kind, project, path, copy])}`;

export function parseFileBuffer(raw: string | null): FileBuffer | null {
    try {
        const b = JSON.parse(raw ?? "null") as FileBuffer | null;
        if (!b || (b.text !== null && typeof b.text !== "string")
            || (b.base !== null && (typeof b.base !== "string" || !/^[a-f0-9]{64}$/i.test(b.base)))
            || !Number.isSafeInteger(b.start) || b.start < 0 || !Number.isSafeInteger(b.end) || b.end < b.start
            || !["forward", "backward", "none"].includes(b.direction)
            || !Number.isFinite(b.top) || b.top < 0 || !Number.isFinite(b.left) || b.left < 0) return null;
        return b;
    } catch { return null; }
}

// 사본별 편집은 덮어쓰지 않는다. 새 탭만 마지막 사본의 snapshot을 이어받는다.
export function loadFileBuffer(store: Store, project: string, path: string, copy: string): { buffer: FileBuffer; copy: string } | null {
    try {
        const own = parseFileBuffer(store.getItem(bufferKey(project, path, copy)));
        if (own) return { buffer: own, copy };
        const previous = store.getItem(`grove.file.latest.${JSON.stringify([project, path])}`);
        const buffer = previous ? parseFileBuffer(store.getItem(bufferKey(project, path, previous))) : null;
        return buffer && previous ? { buffer, copy: previous } : null;
    } catch { return null; }
}

export function saveFileBuffer(store: Store, project: string, path: string, copy: string, buffer: FileBuffer): void {
    store.setItem(bufferKey(project, path, copy), JSON.stringify(buffer));
    store.setItem(`grove.file.latest.${JSON.stringify([project, path])}`, copy);
}

export function loadFileView(store: Store, project: string, copy: string): string | null {
    try { return store.getItem(`grove.file.view.${JSON.stringify([project, copy])}`); }
    catch { return null; }
}

export function saveFileView(store: Store, project: string, copy: string, path: string): void {
    store.setItem(`grove.file.view.${JSON.stringify([project, copy])}`, path);
}

// 복원한 요청도 자동 전송하지 않고 현재 프로젝트·작업·파일에 결합한다.
export function loadFileAttempt(store: Store, key: string, endpoint: string, method: FileAttempt["method"], path?: string): FileAttempt | null {
    try {
        const a = JSON.parse(store.getItem(key) ?? "null") as FileAttempt | null;
        if (!a || a.method !== method || a.path !== endpoint || typeof a.key !== "string" || !a.key
            || !a.body || typeof a.body !== "object" || Array.isArray(a.body)
            || Object.values(a.body).some((v) => v !== null && typeof v !== "string")
            || (path !== undefined && a.body.path !== path)) return null;
        return a;
    } catch { return null; }
}
