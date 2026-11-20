// 서버 상태 조회 cache. 서버 이벤트가 오면 관련 key만 무효화해 다시 읽는다(FRAME-009).
// 소유자: 서버 상태 = 이 cache(서버가 원천), 기기별 UI 상태 = layout(localStorage), 영속 서버 상태는 API로만 변경.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EventRecord } from "../api/generated";
import { refreshFiles } from "./fileWatch";
import { deliveryTiming } from "./deliveryTiming";
import { isTransportError } from "../api/client";
import { usePageVisible, usePaneVisible } from "./paneVisibility";

// stale: 보는 화면이 없어 무효화를 미뤄 둔 항목. 다시 구독하면 그때 한 번 읽는다(PANE-007).
// waiting: 연결 문제로 읽지 못한 항목. 화면에는 오류 대신 기존 값과 로딩 상태를 두고, 연결이 돌아오면 다시 읽는다.
type Flight = { again: boolean; discard: boolean };
type Entry = { data: unknown; error: unknown; loading: boolean; version: number; stale: boolean; waiting?: boolean; flight?: Flight; startedAt?: number; fetcher: () => Promise<unknown> };
/// 구독자가 없는 cache 항목의 최대 보관 수. 넘으면 오래된 것부터 버린다.
export const IDLE_ENTRY_LIMIT = 200;

const entries = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();
/// cache 세대. 로그아웃 정리 뒤에 끝난 이전 조회가 결과를 되살리지 않게 한다.
let generation = 0;

function notify(key: string) {
    for (const f of subs.get(key) ?? []) f();
}

let onTransportFailure: (() => void) | null = null;
/// 연결 상태 소유자(lifecycle)가 등록한다. 조회가 연결 문제로 실패하면 연결 확인을 요청한다.
export function setTransportFailureHandler(handler: (() => void) | null) { onTransportFailure = handler; }

async function load(key: string, keepPending = false) {
    const e = entries.get(key);
    if (!e) return;
    if (e.flight) {
        e.flight.again = true;
        e.flight.discard ||= !keepPending;
        return;
    }
    const flight: Flight = { again: false, discard: false };
    e.flight = flight;
    e.startedAt = Date.now();
    ++e.version;
    const g = generation;
    e.loading = true;
    notify(key);
    let waiting = false;
    try {
        const data = await e.fetcher();
        const current = entries.get(key);
        if (g === generation && current?.flight === flight && !flight.discard) {
            current.data = data;
            current.error = null;
            current.waiting = false;
        }
    } catch (err) {
        const current = entries.get(key);
        if (g === generation && current?.flight === flight) {
            // 연결 문제는 화면별 오류로 보이지 않는다. 기존 값을 두고 연결 복구 뒤 다시 읽는다.
            waiting = isTransportError(err);
            current.waiting = waiting;
            if (!waiting && !flight.again) current.error = err;
        }
    } finally {
        // 로그아웃 정리나 보관 상한으로 버린 항목은 늦게 끝난 조회가 되살리지 않는다.
        const current = entries.get(key);
        if (g !== generation || current?.flight !== flight) return;
        current.flight = undefined;
        current.stale = flight.again;
        current.loading = waiting;
        if (waiting) onTransportFailure?.();
        if (flight.again && !waiting && subs.get(key)?.size) {
            current.stale = false;
            void load(key);
        } else {
            notify(key);
        }
    }
}

/// 보고 있는 key만 다시 읽고, 닫힌 화면의 key는 stale로 표시해 불필요한 요청을 보내지 않는다.
function refresh(k: string, keepPending = false) {
    if (subs.get(k)?.size) void load(k, keepPending);
    else {
        const e = entries.get(k);
        if (e) e.stale = true;
    }
}

/// 화면에 다시 들어왔을 때는 캐시를 유지하며 확인한다. 방금 시작한 선조회·복귀 조회는 재사용한다.
export function revalidateQuery(key: string, freshMs: number) {
    const e = entries.get(key);
    if (!e) return;
    const age = Date.now() - (e.startedAt ?? -Infinity);
    if (!e.waiting && age >= 0 && age < freshMs) return;
    refresh(key, true);
}

let invalidated: Set<string> | null = null;

function refreshPriority(key: string) {
    return /^(messages|turns):/.test(key) ? 0 : /^session:/.test(key) ? 1 : 2;
}

export function invalidate(prefix: string) {
    for (const k of entries.keys()) if (k === prefix || k.startsWith(prefix + ":")) {
        if (invalidated) invalidated.add(k);
        else refresh(k);
    }
}

/// 한 SSE 묶음에서 여러 이벤트가 무효화한 조회는 한 번만, 대화 본문·턴부터 다시 읽는다.
export function batchEventQueries(apply: () => void) {
    if (invalidated) { apply(); return; }
    const batch = invalidated = new Set<string>();
    try { apply(); }
    finally {
        invalidated = null;
        for (const key of [...batch].sort((a, b) => refreshPriority(a) - refreshPriority(b))) refresh(key);
    }
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

export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, options?: { keepPreviousData: true; scope: string }): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
    const paneVisible = usePaneVisible();
    const pageVisible = usePageVisible();
    const visible = paneVisible && pageVisible;
    const [, force] = useState(0);
    const previous = useRef<{ scope: string; generation: number; data: T } | null>(null);
    useEffect(() => {
        if (!key || !visible) return;
        return subscribeQuery(key, fetcher, () => force((x) => x + 1));
        // fetcher는 key가 같으면 같은 대상을 읽는다고 가정한다.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, visible]);
    // 같은 자원의 시간 조건이 갱신돼도 다음 재검증은 최신 fetcher를 사용한다.
    useEffect(() => {
        const entry = key ? entries.get(key) : undefined;
        if (entry && visible) entry.fetcher = fetcher;
    });
    const snapshot = querySnapshot<T>(key);
    if (options && snapshot.data !== undefined) previous.current = { scope: options.scope, generation, data: snapshot.data };
    const placeholder = !!key && snapshot.data === undefined && !!options
        && previous.current?.scope === options.scope && previous.current.generation === generation;
    return { ...snapshot, data: placeholder ? previous.current!.data : snapshot.data,
        loading: snapshot.loading || (placeholder && !entries.has(key!)), reload: () => key && refresh(key) };
}

export function querySnapshot<T>(key: string | null): { data: T | undefined; error: unknown; loading: boolean } {
    const e = key ? entries.get(key) : undefined;
    return { data: e?.data as T | undefined, error: e?.error, loading: e?.loading ?? false };
}

/// 이벤트 종류 → 무효화할 key 접두사.
export function applyEvent(e: EventRecord) {
    // 같은 stream에서 먼저 받은 임시 응답을 반영한 뒤 확정 이벤트를 적용해 순서를 지킨다.
    flushPartials();
    const sid = e.session_id;
    const pid = e.project_id;
    switch (e.kind) {
        case "layout.updated": {
            const id = (e.payload as { device_id?: string })?.device_id;
            if (id?.startsWith("workspace-tabs-")) invalidate(`workspace-layout:${id}`);
            break;
        }
        case "message.created":
            invalidate("usage:dashboard");
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
                const turn = e.payload as { id: string; status: string };
                if (["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) {
                    deliveryTiming.receive(sid, turn.id);
                    // 이전 턴의 종료 이벤트가 다음 턴의 응답을 지우면 안 된다.
                    if ((live.partials[sid] as { turn_id?: string } | null)?.turn_id === turn.id) {
                        setLive((l) => {
                            const partials = { ...l.partials };
                            delete partials[sid];
                            return { ...l, partials };
                        });
                    }
                }
            }
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
        case "memory.updated":
            invalidate("memory");
            break;
        case "session.created":
        case "session.updated":
            if (pid) invalidate(`sessions:${pid}`);
            if (pid) invalidate(`worktrees:${pid}`);
            if (sid) invalidate(`session:${sid}`);
            invalidate("recent");
            invalidate("search");
            invalidate("bot-rooms");
            if (sid) invalidate(`bot-room:${sid}`);
            // 대화 활동이 바뀌면 최근 활동 순 프로젝트 목록 순서도 바뀐다(PROJECT-002).
            invalidate("projects:recent");
            break;
        case "session.deleted": {
            const id = (e.payload as { id?: string })?.id;
            if (pid) invalidate(`sessions:${pid}`);
            if (id) invalidate(`session:${id}`);
            invalidate("recent");
            invalidate("search");
            invalidate("bot-rooms");
            break;
        }
        case "project.created":
        case "project.updated":
            invalidate("projects");
            invalidate("project-folders");
            invalidate("bot-rooms");
            // 워크스페이스 모드 등 프로젝트 화면·입력창이 쓰는 단건 조회도 갱신한다(다른 기기의 변경 포함).
            if (pid) invalidate(`project:${pid}`);
            if (pid) invalidate(`setup:${pid}`);
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
        case "project_folder.changed":
        case "project_folder.deleted":
            invalidate("project-folders");
            break;
        case "definition.changed":
        case "definition.deleted":
            invalidate("definitions");
            break;
        case "profile.changed":
            invalidate("profiles");
            invalidate("usage:accounts");
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
        case "git.changed":
            if (pid) invalidate(`git:${pid}`);
            break;
        case "worktree.changed":
            if (pid) invalidate(`worktrees:${pid}`);
            if (pid) invalidate(`setup:${pid}`);
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
            invalidate("bot-rooms");
            invalidate("bot-room");
            break;
        case "bot_room.changed":
            invalidate("bot-rooms");
            if (sid) invalidate(`bot-room:${sid}`);
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
            // 초기 설정 상태는 작업 상태에서 읽는다(PROJECT-010).
            if (pid) invalidate(`setup:${pid}`);
            break;
        case "remote_watch.changed":
            if (sid) invalidate(`remote-watches:${sid}`);
            break;
        case "project_script.changed":
            if (pid) invalidate(`scripts:${pid}`);
            if (pid) invalidate(`setup:${pid}`);
            break;
        case "file.changed":
            refreshFiles(pid ?? undefined);
            if (pid) {
                invalidate(`files:${pid}`);
                invalidate(`git:${pid}`);
                invalidate(`trash:${pid}`);
            }
            break;
        default:
            break;
    }
}

/// 연결이 돌아오면 연결 문제로 읽지 못한 조회만 다시 읽는다. 보이지 않는 항목은 다시 볼 때 읽는다.
export function retryWaiting() {
    for (const [k, e] of entries) if (e.waiting && !e.flight) refresh(k);
}

/// 재동기화: 모든 조회를 다시 읽는다(NET-008).
export function resyncAll(keepPending = false) {
    resetStreamPartials();
    // 단순 연결 재검증은 진행 중인 정상 응답을 먼저 표시할 수 있다. 실제 변경 이벤트는 이전 결과를 버린다.
    for (const k of [...entries.keys()].sort((a, b) => refreshPriority(a) - refreshPriority(b))) refresh(k, keepPending);
    refreshFiles();
}

export function resetStreamPartials() {
    deliveryTiming.clear();
    dropPendingPartials();
    setLive((l) => ({ ...l, partials: {} }));
}

// ---- 연결 상태·중간 응답(메모리) ----

type Live = { status: "connecting" | "live" | "reconnecting" | "offline" | "auth_expired"; retryAt?: number; partials: Record<string, unknown> };
let live: Live = { status: "connecting", partials: {} };
const liveSubs = new Set<() => void>();

export function setLive(f: (l: Live) => Live) {
    live = f(live);
    for (const s of liveSubs) s();
}

// 서버는 대화마다 최대 50ms 간격으로 응답 전체 snapshot을 보낸다. 여러 대화가 동시에 응답하면
// 대화 화면과 Markdown을 그만큼 다시 그리므로, 화면 반영은 대화와 무관하게 PARTIAL_FLUSH_MS에 한 번으로 묶는다.
// 묶음 사이에 온 같은 대화의 snapshot은 최신 것만 남긴다. 첫 snapshot은 기다리지 않고 바로 반영한다.
export const PARTIAL_FLUSH_MS = 100;
let pendingPartials = new Map<string, unknown>();
let partialTimer: ReturnType<typeof setTimeout> | null = null;
let lastPartialFlush = -Infinity;

export function queuePartial(sessionId: string, snapshot: unknown) {
    pendingPartials.set(sessionId, snapshot);
    if (partialTimer) return;
    const wait = lastPartialFlush + PARTIAL_FLUSH_MS - performance.now();
    if (wait <= 0) flushPartials();
    else partialTimer = setTimeout(flushPartials, wait);
}

export function flushPartials() {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
    if (pendingPartials.size === 0) return;
    const next = pendingPartials;
    pendingPartials = new Map();
    lastPartialFlush = performance.now();
    setLive((l) => ({ ...l, partials: { ...l.partials, ...Object.fromEntries(next) } }));
}

// 새 연결·인증 세대의 첫 snapshot은 이전 묶음 시각과 무관하게 바로 보인다.
function dropPendingPartials() {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
    pendingPartials = new Map();
    lastPartialFlush = -Infinity;
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
    deliveryTiming.clear();
    dropPendingPartials();
    generation += 1;
    entries.clear();
    for (const k of [...subs.keys()]) notify(k);
    setLive(() => ({ status: "connecting", partials: {} }));
}
