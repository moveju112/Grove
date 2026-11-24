// 대화의 과거 페이지 조회·병합·보관. 최신 창(messages:<id> query)은 store가 소유하고, 이 모듈은 그보다 앞의 구간만 다룬다.

import { api, authGeneration } from "../api/client";
import type { Message, MessagePage } from "../api/generated";

/// 서버가 한 번에 돌려주는 최대 메시지 수(src/sessions.rs의 clamp와 같다).
export const RANGE_WINDOW = 500;
/// 목적지 앞에 함께 보여 줄 문맥 메시지 수.
export const RANGE_CONTEXT = 50;
/// 구간 채우기의 동시 요청 수. 순차 대기는 없애되 연결 하나를 한꺼번에 막지 않는다.
export const RANGE_CONCURRENCY = 4;
export const CONVERSATION_PAGE_SIZE = 100;

export function conversationPagePath(sessionId: string, limit = CONVERSATION_PAGE_SIZE, cursor?: { before: number } | { after: number }) {
    const edge = !cursor ? "" : "before" in cursor ? `&before_seq=${cursor.before}` : `&after_seq=${cursor.after}`;
    return `/sessions/${sessionId}/messages?limit=${limit}${edge}&view=conversation`;
}

type Get = (path: string) => Promise<MessagePage>;
const defaultGet: Get = (path) => api.get<MessagePage>(path);

/// seq 기준으로 합치고 같은 seq는 한 번만 둔다. 같은 페이지가 두 번 도착해도 중복 삽입하지 않는다.
export function mergeMessages(...lists: Message[][]): Message[] {
    const bySeq = new Map<number, Message>();
    for (const list of lists) for (const m of list) bySeq.set(m.seq, m);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const out: T[] = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const i = next++;
            out[i] = await jobs[i]!();
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    return out;
}

/// `target`부터 `upper`(미포함) 직전까지를 한 번에 읽는다. 목적지 앞 문맥과 사이 구간을 seq 범위로 나눠 병렬 조회한다.
/// 같은 timeline이 아니면(되감기 등) null을 돌려준다.
export async function readMessageRange(sessionId: string, target: number, upper: number, revision: number, get: Get = defaultGet, onTarget?: (page: MessagePage) => void): Promise<{ items: Message[]; more: boolean } | null> {
    const head = async () => {
        const page = await get(conversationPagePath(sessionId, RANGE_CONTEXT, { before: Math.min(target + 1, upper) }));
        if (page.timeline_revision === revision && page.items.some((item) => item.seq === target)) onTarget?.(page);
        return page;
    };
    const windows: (() => Promise<MessagePage>)[] = [];
    // 각 창은 (a, a+500] 범위의 seq를 모두 담는다. seq는 대화 안에서 유일하므로 한 창이 500개를 넘지 않는다.
    for (let a = target; a < upper - 1; a += RANGE_WINDOW) {
        const from = a;
        windows.push(() => get(conversationPagePath(sessionId, RANGE_WINDOW, { after: from })).then((page) => ({
            ...page, items: page.items.filter((m) => m.seq <= from + RANGE_WINDOW && m.seq < upper),
        })));
    }
    const [first, ...rest] = await pool([head, ...windows], RANGE_CONCURRENCY);
    const pages = [first!, ...rest];
    if (pages.some((page) => page.timeline_revision !== revision)) return null;
    return { items: mergeMessages(...pages.map((page) => page.items.filter((m) => m.seq < upper))), more: first!.has_more_before };
}

/// 같은 key의 진행 중 요청을 공유한다. 첫 응답 전에 여러 번 호출해도 요청은 하나다.
export function singleFlight() {
    const flights = new Map<string, Promise<void>>();
    return {
        run(key: string, task: () => Promise<void>): Promise<void> {
            const running = flights.get(key);
            if (running) return running;
            const flight = task().finally(() => { if (flights.get(key) === flight) flights.delete(key); });
            flights.set(key, flight);
            return flight;
        },
        busy: (key: string) => flights.has(key),
    };
}

// 탭 전환으로 대화 화면이 내려가도 읽던 과거 구간을 잠시 보관한다. 최근 대화 몇 개·총 용량으로 제한한다.
export const KEPT_SESSIONS = 8;
export const KEPT_CHARS = 4_000_000;
type Kept = { auth: number; revision: number; items: Message[]; through: number; more: boolean | null; chars: number };
const kept = new Map<string, Kept>();

/// `items`는 화면에 있던 전체(이전 구간 + 최신 창)다. 최신 창까지 함께 두어 돌아왔을 때 이어지는지 확인한다.
export function keepOlderPages(sessionId: string, revision: number, items: Message[], more: boolean | null) {
    kept.delete(sessionId);
    if (items.length === 0) return;
    const chars = JSON.stringify(items).length;
    if (chars > KEPT_CHARS) return;
    kept.set(sessionId, { auth: authGeneration(), revision, items, through: items.at(-1)!.seq, more, chars });
    let total = [...kept.values()].reduce((sum, entry) => sum + entry.chars, 0);
    for (const [id, entry] of kept) {
        if (kept.size <= KEPT_SESSIONS && total <= KEPT_CHARS) break;
        kept.delete(id);
        total -= entry.chars;
    }
}

/// 같은 timeline이고 보관 구간이 현재 최신 창과 이어질 때만 최신 창 앞부분을 돌려준다. 끊겼으면 버린다.
export function takeOlderPages(sessionId: string, latest: MessagePage): { items: Message[]; more: boolean | null } | null {
    const entry = kept.get(sessionId);
    const first = latest.items[0]?.seq;
    if (!entry || first == null) return null;
    if (entry.auth !== authGeneration() || entry.revision !== latest.timeline_revision || entry.through < first) {
        kept.delete(sessionId);
        return null;
    }
    // 최근 사용 순서를 갱신한다.
    kept.delete(sessionId);
    kept.set(sessionId, entry);
    const items = entry.items.filter((m) => m.seq < first);
    return items.length ? { items, more: entry.more } : null;
}

export function clearKeptPages() { kept.clear(); }
