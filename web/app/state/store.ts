// 서버 상태 조회 cache. 서버 이벤트가 오면 관련 key만 무효화해 다시 읽는다(FRAME-009).
// 소유자: 서버 상태 = 이 cache(서버가 원천), 기기별 UI 상태 = layout/drafts(localStorage), 영속 서버 상태는 API로만 변경.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { EventRecord } from "../api/generated";
import { refreshFiles } from "./fileWatch";

// stale: 보는 화면이 없어 무효화를 미뤄 둔 항목. 다시 구독하면 그때 한 번 읽는다(PANE-007).
type Entry = { data: unknown; error: unknown; loading: boolean; version: number; stale: boolean; fetcher: () => Promise<unknown> };
/// 구독자가 없는 cache 항목의 최대 보관 수. 넘으면 오래된 것부터 버린다.
export const IDLE_ENTRY_LIMIT = 200;

const entries = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();
/// cache 세대. 로그아웃 정리 뒤에 끝난 이전 조회가 결과를 되살리지 않게 한다.
let generation = 0;

function notify(key: string) {
    for (const f of subs.get(key) ?? []) f();
}

async function load(key: string) {
    const e = entries.get(key);
    if (!e) return;
    const v = ++e.version;
    const g = generation;
    e.loading = true;
    notify(key);
    try {
        const data = await e.fetcher();
        if (e.version === v) {
            e.data = data;
            e.error = null;
        }
    } catch (err) {
        if (e.version === v) e.error = err;
    } finally {
        // 로그아웃 정리나 보관 상한으로 버린 항목은 늦게 끝난 조회가 되살리지 않는다.
        if (g !== generation || entries.get(key) !== e) return;
        if (e.version === v) {
            e.loading = false;
            // 객체 identity를 바꿔 구독자가 다시 그리게 한다.
            entries.set(key, { ...e });
            notify(key);
        }
    }
}

/// 보고 있는 key만 다시 읽고, 닫힌 화면의 key는 stale로 표시해 불필요한 요청을 보내지 않는다.
function refresh(k: string) {
    if (subs.get(k)?.size) void load(k);
    else {
        const e = entries.get(k);
        if (e) e.stale = true;
    }
}

export function invalidate(prefix: string) {
    for (const k of entries.keys()) if (k === prefix || k.startsWith(prefix + ":")) refresh(k);
}

/// 같은 key의 여러 viewer는 한 항목·한 요청을 공유한다. 반환한 함수로 각 viewer를 해제한다.
export function subscribeQuery(key: string, fetcher: () => Promise<unknown>, listener: () => void): () => void {
    let e = entries.get(key);
    if (!e) {
        e = { data: undefined, error: null, loading: false, version: 0, stale: false, fetcher };
        entries.set(key, e);
        void load(key);
    } else {
        e.fetcher = fetcher;
        if (e.stale) {
            e.stale = false;
            void load(key);
        }
    }
    const set = subs.get(key) ?? new Set();
    set.add(listener);
    subs.set(key, set);
    return () => {
        set.delete(listener);
        if (set.size > 0 || subs.get(key) !== set) return;
        subs.delete(key);
        pruneIdle();
    };
}

function pruneIdle() {
    const idle = [...entries.keys()].filter((k) => !subs.get(k)?.size);
    for (const k of idle.slice(0, Math.max(0, idle.length - IDLE_ENTRY_LIMIT))) entries.delete(k);
}

export function cacheStats(): { entries: number; subscribed: number } {
    return { entries: entries.size, subscribed: [...subs.values()].filter((s) => s.size > 0).length };
}

export function setData(key: string, data: unknown) {
    const e = entries.get(key);
    if (e) {
        entries.set(key, { ...e, data });
        notify(key);
    }
}

export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
    const [, force] = useState(0);
    useEffect(() => {
        if (!key) return;
        return subscribeQuery(key, fetcher, () => force((x) => x + 1));
        // fetcher는 key가 같으면 같은 대상을 읽는다고 가정한다.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const e = key ? entries.get(key) : undefined;
    return { data: e?.data as T | undefined, error: e?.error, loading: e?.loading ?? false, reload: () => key && void load(key) };
}

/// 이벤트 종류 → 무효화할 key 접두사.
export function applyEvent(e: EventRecord) {
    const sid = e.session_id;
    const pid = e.project_id;
    switch (e.kind) {
        case "message.created":
            if (sid) {
                invalidate(`messages:${sid}`);
                invalidate(`context:${sid}`);
            }
            invalidate("recent");
            invalidate("bots");
            invalidate("search");
            break;
        case "session.rewound":
            if (sid) {
                invalidate(`messages:${sid}`);
                invalidate(`context:${sid}`);
                invalidate(`turns:${sid}`);
                invalidate(`calls:${sid}`);
                invalidate(`session:${sid}`);
            }
            if (pid) invalidate(`sessions:${pid}`);
            invalidate("recent");
            invalidate("bots");
            invalidate("search");
            break;
        case "turn.updated":
            if (sid) {
                invalidate(`turns:${sid}`);
                invalidate(`session:${sid}`);
            }
            invalidate("usage-capacity");
            invalidate("recent");
            invalidate("bots");
            invalidate("recovery");
            break;
        case "tool_call.updated":
            if (sid) {
                invalidate(`calls:${sid}`);
                invalidate(`session:${sid}`);
            }
            invalidate("recent");
            invalidate("recovery");
            break;
        case "file_changes.updated":
            if (sid) invalidate(`changes:${sid}`);
            refreshFiles(pid ?? undefined);
            break;
        case "session.created":
        case "session.updated":
            if (pid) invalidate(`sessions:${pid}`);
            if (pid) invalidate(`worktrees:${pid}`);
            if (sid) invalidate(`session:${sid}`);
            invalidate("recent");
            invalidate("search");
            // 대화 활동이 바뀌면 최근 활동 순 프로젝트 목록 순서도 바뀐다(PROJECT-002).
            invalidate("projects:recent");
            break;
        case "session.deleted": {
            const id = (e.payload as { id?: string })?.id;
            if (pid) invalidate(`sessions:${pid}`);
            if (id) invalidate(`session:${id}`);
            invalidate("recent");
            invalidate("search");
            invalidate("memories");
            break;
        }
        case "project.created":
        case "project.updated":
            invalidate("projects");
            invalidate("recent");
            invalidate("search");
            break;
        case "recent.updated":
            invalidate("recent");
            break;
        case "label.changed":
        case "label.deleted":
            invalidate("labels");
            break;
        case "definition.changed":
        case "definition.deleted":
            invalidate("definitions");
            break;
        case "profile.changed":
            invalidate("profiles");
            invalidate("bots");
            break;
        case "secret.changed":
            invalidate("secrets");
            invalidate("profiles");
            invalidate("bots");
            break;
        case "device.created":
        case "device.revoked":
            invalidate("devices");
            break;
        case "pairing.changed":
            invalidate("pairings");
            break;
        case "setting.changed":
            invalidate("settings");
            break;
        case "memories.changed":
            invalidate("memories");
            invalidate("context");
            break;
        case "git.changed":
            if (pid) invalidate(`git:${pid}`);
            break;
        case "worktree.changed":
            if (pid) invalidate(`worktrees:${pid}`);
            break;
        case "terminal.changed":
        case "terminal.removed":
            if (pid) invalidate(`terminals:${pid}`);
            break;
        case "goals.changed":
            if (sid) invalidate(`goals:${sid}`);
            break;
        case "followups.changed":
            if (sid) invalidate(`followups:${sid}`);
            break;
        case "agent_run.changed":
            // 부모 세션 목록과 자식 세션 화면의 부모 표시를 함께 갱신한다.
            invalidate("agent-runs");
            break;
        case "bot.changed":
        case "bot.seen":
        case "bot.order":
            invalidate("bots");
            break;
        case "schedule.changed":
        case "schedule.run":
            invalidate("schedules");
            break;
        case "notification.created":
        case "notification.delivered":
        case "notification.read":
            invalidate("notifications");
            break;
        case "task.changed":
            if (sid) invalidate(`tasks:${sid}`);
            break;
        case "remote_watch.changed":
            if (sid) invalidate(`remote-watches:${sid}`);
            break;
        case "project_script.changed":
            if (pid) invalidate(`scripts:${pid}`);
            break;
        case "file.changed":
            refreshFiles(pid ?? undefined);
            if (pid) {
                invalidate(`files:${pid}`);
                invalidate(`git:${pid}`);
                invalidate(`trash:${pid}`);
            }
            break;
        case "draft.updated":
            invalidate(`draft:${(e.payload as { resource_key?: string })?.resource_key ?? ""}`);
            break;
        default:
            break;
    }
}

/// 재동기화: 모든 조회를 다시 읽는다(NET-008).
export function resyncAll() {
    for (const k of entries.keys()) refresh(k);
    refreshFiles();
}

// ---- 연결 상태·중간 응답(메모리) ----

type Live = { status: "connecting" | "live" | "reconnecting" | "offline" | "auth_expired"; retryAt?: number; partials: Record<string, unknown> };
let live: Live = { status: "connecting", partials: {} };
const liveSubs = new Set<() => void>();

export function setLive(f: (l: Live) => Live) {
    live = f(live);
    for (const s of liveSubs) s();
}

const subscribeLive = (cb: () => void) => {
    liveSubs.add(cb);
    return () => { liveSubs.delete(cb); };
};

// selector는 기존 snapshot의 필드/객체를 반환한다. 무관한 대화의 frame은 렌더링을 유발하지 않는다.
export function useLive<T>(select: (value: Live) => T): T {
    return useSyncExternalStore(
        subscribeLive,
        () => select(live),
        () => select(live),
    );
}

/// 로그아웃·인증 만료(UI-032): 서버에서 읽은 모든 상태와 중간 응답을 메모리에서 지운다.
export function clearServerCache() {
    generation += 1;
    entries.clear();
    for (const k of [...subs.keys()]) notify(k);
    setLive(() => ({ status: "connecting", partials: {} }));
}
