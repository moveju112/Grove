import { ApiError, api, newKey } from "../api/client";

export type ProjectScript = { id: string; project_id: string; name: string; command: string; revision: number };
export type Execution = { root: string; shell: string; fingerprint: string };
export type ScriptListing = { scripts: ProjectScript[]; execution: Execution | null; owner: string };
export type RunAttempt = {
    format: 1; projectId: string; projectName: string; actorId: string; script: ProjectScript; execution: Execution;
    sessionKey: string; taskKey: string; sessionId?: string;
    /// 초기 설정 실행(PROJECT-010): 실행 위치(null=프로젝트 폴더). 그 위치의 새 대화에서 실행한다.
    setup?: { worktreeId: string | null };
};
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const prefix = (project: string) => `grove.script.run.${project}.`;
export const runKey = (attempt: RunAttempt) => prefix(attempt.projectId) + attempt.taskKey;
const listeners = new Set<() => void>();
export function subscribeScriptRuns(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
const notify = () => { for (const listener of listeners) listener(); };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

export function parseRun(raw: string | null, project: string): RunAttempt | null {
    try {
        const value = JSON.parse(raw ?? "null") as RunAttempt | null;
        if (!value || value.format !== 1 || value.projectId !== project || !id(project) || !id(value.actorId)
            || !text(value.projectName, 200) || !key(value.sessionKey) || !key(value.taskKey)
            || value.sessionId !== undefined && !id(value.sessionId)
            || value.setup !== undefined && (typeof value.setup !== "object" || value.setup === null || (value.setup.worktreeId !== null && !id(value.setup.worktreeId)))) return null;
        const script = value.script, execution = value.execution;
        if (!script || !id(script.id) || script.project_id !== project || !text(script.name, 160)
            || !text(script.command, 65536) || new TextEncoder().encode(script.command).length > 65536 || script.command.includes("\0")
            || !Number.isSafeInteger(script.revision) || script.revision < 1 || !execution
            || !text(execution.root, 32768) || !text(execution.shell, 4096) || !/^[a-f0-9]{64}$/.test(execution.fingerprint)) return null;
        return value;
    } catch { return null; }
}

export function pendingRuns(store: Store & Pick<Storage, "length" | "key">, project: string) {
    const rows: { key: string; attempt: RunAttempt | null }[] = [];
    for (let index = 0; index < store.length; index++) {
        const name = store.key(index);
        if (name?.startsWith(prefix(project))) {
            const attempt = parseRun(store.getItem(name), project);
            rows.push({ key: name, attempt: attempt && runKey(attempt) === name ? attempt : null });
        }
    }
    return rows;
}

export function newRun(projectName: string, actorId: string, script: ProjectScript, execution: Execution, setup?: { worktreeId: string | null }): RunAttempt {
    const base = newKey();
    return { format: 1, projectId: script.project_id, projectName, actorId, script: { ...script }, execution: { ...execution },
        sessionKey: `${base}:session`, taskKey: `${base}:task`, ...(setup ? { setup: { ...setup } } : {}) };
}
export function forgetRun(store: Store, name: string) {
    store.removeItem(name);
    notify();
}
export type RunTransport = {
    owner: () => Promise<string>;
    session: (attempt: RunAttempt) => Promise<{ id: string }>;
    task: (attempt: RunAttempt & { sessionId: string }) => Promise<{ id: string }>;
};
const transport: RunTransport = {
    owner: async () => (await api.get<{ root_id: string }>("/auth/whoami")).root_id,
    session: (attempt) => api.post(`/projects/${attempt.projectId}/sessions`, attempt.setup
        ? { title: `초기 설정 · ${attempt.script.name}`, ...(attempt.setup.worktreeId ? { worktree_id: attempt.setup.worktreeId } : {}) }
        : { title: `Script · ${attempt.script.name}` },
        { key: attempt.sessionKey, requires: ["project_scripts_v1"] }),
    task: (attempt) => api.post(`/sessions/${attempt.sessionId}/scripts/${attempt.script.id}/run`, {
        command: attempt.script.command, expected_revision: attempt.script.revision, expected_execution: attempt.execution.fingerprint, expected_owner: attempt.actorId,
        ...(attempt.setup ? { setup: true } : {}),
    }, { key: attempt.taskKey, requires: ["project_scripts_v1"] }),
};

// 실행 요청은 UI 수명과 분리한다. 인증이 끝나면 새 단계·기기 사본 쓰기를 멈춘다.
export async function confirmRun(store: Store, original: RunAttempt, active: () => boolean, remote: RunTransport = transport) {
    const requireActive = () => { if (!active()) throw new DOMException("인증 상태가 바뀌었습니다", "AbortError"); };
    const save = (attempt: RunAttempt) => {
        requireActive();
        try { store.setItem(runKey(attempt), JSON.stringify(attempt)); }
        catch { throw new Error("실행 요청 사본을 보관하지 못해 다음 단계를 진행하지 않았습니다. 기기 저장 공간을 확인하세요."); }
        notify();
    };
    requireActive();
    const owner = await remote.owner();
    requireActive();
    if (owner !== original.actorId) throw new ApiError(403, "actor_changed", "원래 인증으로 실행 요청의 결과를 확인하세요.", false);
    let attempt = original;
    const raw = store.getItem(runKey(attempt));
    if (raw !== null) {
        const observed = parseRun(raw, attempt.projectId);
        const identity = (value: RunAttempt) => JSON.stringify([
            value.projectId, value.actorId, value.script.id, value.script.project_id, value.script.name, value.script.command, value.script.revision,
            value.execution.root, value.execution.shell, value.execution.fingerprint, value.sessionKey, value.taskKey, value.setup?.worktreeId,
            value.setup !== undefined,
        ]);
        if (!observed || identity(observed) !== identity(attempt)) throw new Error("실행 요청 사본이 바뀌었습니다. 원래 작업을 확인하세요.");
        attempt = observed;
    }
    save(attempt);
    if (!attempt.sessionId) {
        const session = await remote.session(attempt);
        requireActive();
        attempt = { ...attempt, sessionId: session.id };
        save(attempt);
    }
    const task = await remote.task(attempt as RunAttempt & { sessionId: string });
    requireActive();
    forgetRun(store, runKey(attempt));
    return { sessionId: attempt.sessionId!, taskId: task.id };
}
