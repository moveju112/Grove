import { api, authGeneration } from "../api/client";
import type { Message, MessagePage } from "../api/generated";

const pending = new Map<string, Promise<MessagePage>>();

// 같은 인증 세대·대화·커서의 진행 중인 읽기만 공유한다. 완료한 응답은 여기 저장하지 않는다.
export function readMessagePage(session: string, query: string): Promise<MessagePage> {
    const key = `${authGeneration()}:${session}:${query}`;
    const running = pending.get(key);
    if (running) return running;
    const request = api.get<MessagePage>(`/sessions/${session}/messages?${query}`).finally(() => {
        if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
}

export function mergeMessagePages(...pages: Message[][]): Message[] {
    const bySeq = new Map<number, Message>();
    for (const page of pages) for (const message of page) bySeq.set(message.seq, message);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export async function readAroundMessage(session: string, seq: number, revision: number) {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq >= Number.MAX_SAFE_INTEGER) return null;
    const [before, after] = await Promise.all([
        readMessagePage(session, `limit=51&before_seq=${seq + 1}`),
        readMessagePage(session, `limit=50&after_seq=${seq}`),
    ]);
    if (before.timeline_revision !== revision || after.timeline_revision !== revision) return undefined;
    if (!before.items.some((message) => message.seq === seq)) return null;
    return {
        items: mergeMessagePages(before.items, after.items),
        before: before.has_more_before, after: after.has_more_after, revision,
    };
}

export type HistoryWindow = NonNullable<Awaited<ReturnType<typeof readAroundMessage>>>;
