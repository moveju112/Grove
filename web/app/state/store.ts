// 서버 상태 조회 cache. 서버 이벤트가 오면 관련 key만 무효화해 다시 읽는다(FRAME-009).
// 소유자: 서버 상태 = 이 cache(서버가 원천), 기기별 UI 상태 = layout/drafts(localStorage), 영속 서버 상태는 API로만 변경.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { EventRecord } from "../api/generated";

type Entry = { data: unknown; error: unknown; loading: boolean; version: number; fetcher: () => Promise<unknown> };

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
        if (g !== generation) return;
        if (e.version === v) {
            e.loading = false;
            // 객체 identity를 바꿔 구독자가 다시 그리게 한다.
            entries.set(key, { ...e });
            notify(key);
        }
    }
}

export function invalidate(prefix: string) {
    for (const k of entries.keys()) if (k === prefix || k.startsWith(prefix + ":")) void load(k);
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
        let e = entries.get(key);
        if (!e) {
            e = { data: undefined, error: null, loading: false, version: 0, fetcher };
            entries.set(key, e);
            void load(key);
        } else {
            e.fetcher = fetcher;
        }
        const set = subs.get(key) ?? new Set();
        const f = () => force((x) => x + 1);
        set.add(f);
        subs.set(key, set);
        return () => {
            set.delete(f);
        };
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
            invalidate("recent");
            invalidate("bots");
            break;
        case "tool_call.updated":
            if (sid) {
                invalidate(`calls:${sid}`);
                invalidate(`session:${sid}`);
            }
            invalidate("recent");
            break;
        case "file_changes.updated":
            if (sid) invalidate(`changes:${sid}`);
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
            break;
        }
        case "project.created":
        case "project.updated":
            invalidate("projects");
            invalidate("recent");
            break;
        case "recent.updated":
            invalidate("recent");
            break;
        case "definition.changed":
        case "definition.deleted":
            invalidate("definitions");
            break;
        case "profile.changed":
            invalidate("profiles");
            break;
        case "secret.changed":
            invalidate("secrets");
            break;
        case "device.created":
        case "device.revoked":
            invalidate("devices");
            break;
        case "setting.changed":
            invalidate("settings");
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
        case "notification.read":
            invalidate("notifications");
            break;
        case "task.changed":
            if (sid) invalidate(`tasks:${sid}`);
            break;
        case "file.changed":
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
    for (const k of entries.keys()) void load(k);
}

// ---- 연결 상태·중간 응답(메모리) ----

type Live = { status: "connecting" | "live" | "reconnecting" | "offline" | "auth_expired"; retryAt?: number; partials: Record<string, unknown> };
let live: Live = { status: "connecting", partials: {} };
const liveSubs = new Set<() => void>();

export function setLive(f: (l: Live) => Live) {
    live = f(live);
    for (const s of liveSubs) s();
}

export function useLive(): Live {
    return useSyncExternalStore(
        (cb) => {
            liveSubs.add(cb);
            return () => liveSubs.delete(cb);
        },
        () => live,
        () => live,
    );
}

/// 로그아웃·인증 만료(UI-032): 서버에서 읽은 모든 상태와 중간 응답을 메모리에서 지운다.
export function clearServerCache() {
    generation += 1;
    entries.clear();
    for (const k of [...subs.keys()]) notify(k);
    setLive(() => ({ status: "connecting", partials: {} }));
}
