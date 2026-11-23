import type { Message } from "../api/generated";
import type { Attachment } from "../state/sendRecovery";
import { foldResponseEntries, type ResponseContent } from "./AssistantResponse";

type LiveResponse = ResponseContent & { turn_id: string };
type SavedContent = ResponseContent & { attachments?: Attachment[] };
type ProgressBlock = { content: ResponseContent; start: number };
export type AssistantRow = {
    latest: Message;
    content: ResponseContent;
    prior: ResponseContent[];
    attachments: Attachment[];
    live: boolean;
    progressStart: number;
};

/// 같은 턴이어도 사용자 메시지를 넘어 앞쪽 응답에 합치지 않는다.
export function assistantTranscript(messages: readonly Message[], live?: LiveResponse, showProgress = true) {
    const groups = new Map<string, Message[]>();
    const tailGroups = new Map<string, Message[]>();
    const steerMessages = new Map<string, Message>();
    for (const message of messages) {
        const turn = message.turn_id;
        if (message.role === "user" && turn) {
            tailGroups.delete(turn);
            const source = (message.content as { source?: { kind?: string; followup_id?: string } }).source;
            if (source?.kind === "steer" && source.followup_id) steerMessages.set(source.followup_id, message);
        } else if (message.role === "assistant") {
            const group = (turn && tailGroups.get(turn)) || [];
            group.push(message);
            if (turn) tailGroups.set(turn, group);
            groups.set(message.id, group);
        }
    }
    const liveGroup = live && tailGroups.get(live.turn_id);
    const latest = liveGroup && liveGroup.at(-1)!.content as SavedContent | undefined;
    // 확정 답변이 partial 지우기보다 먼저 도착해도 중복하지 않는다.
    const running = !!liveGroup && !!(latest?.tool_calls?.length || latest?.pending_work);
    const showLive = !!live && (!liveGroup || running);
    const beforeSteer = new Map<string, ResponseContent[]>();
    function splitAtSteers<T extends ResponseContent>(content: T, turn: string | null, committed: boolean): T {
        const parts = content.response_parts;
        if (!turn || !parts?.length || !content.response_steers?.length) return content;
        // 확정된 최종 답변은 언제 스트리밍을 시작했든 마지막 사용자 메시지 아래에 남긴다.
        const limit = committed && !content.pending_work && !content.tool_calls?.length ? parts.length - 1 : parts.length;
        let start = 0;
        for (const [id, count] of content.response_steers) {
            const user = steerMessages.get(id);
            const end = Math.min(count, limit);
            if (!user || user.turn_id !== turn || end <= start) continue;
            const blocks = beforeSteer.get(user.id) ?? [];
            blocks.push({
                response_parts: parts.slice(start, end),
                response_part_times: content.response_part_times?.slice(start, end),
                pending_work: true,
            });
            beforeSteer.set(user.id, blocks);
            start = end;
        }
        return start === 0 ? content : {
            ...content, text: parts.slice(start).join("\n\n"), response_parts: parts.slice(start),
            response_part_times: content.response_part_times?.slice(start),
        };
    }
    const savedSteps = new Map(messages.filter((message) => message.role === "assistant").map((message) =>
        [message.id, splitAtSteers(message.content as SavedContent, message.turn_id, true)] as const));
    const liveContent = showLive ? splitAtSteers(live!, live!.turn_id, false) : undefined;
    const counts = new Map<string, number>();
    function number(turn: string | null, count: number) {
        if (!turn) return 1;
        const previous = counts.get(turn) ?? 0;
        counts.set(turn, previous + count);
        return previous + 1;
    }
    const rows: Message[] = [];
    const assistants = new Map<string, AssistantRow>();
    const preceding = new Map<string, ProgressBlock>();
    const anchors = new Map<number, number>();
    for (const message of messages) {
        if (message.role === "tool") continue;
        if (message.role !== "assistant") {
            const type = (message.content as { type?: string }).type;
            if (message.role === "note" && (type === "cli_activity" || type === "task_result")) continue;
            const parts = beforeSteer.get(message.id);
            if (showProgress && parts?.length) {
                const { progress } = foldResponseEntries({}, parts);
                if (progress.length) preceding.set(message.id, {
                    start: number(message.turn_id, progress.length),
                    content: { pending_work: true, response_parts: progress.map(({ text }) => text),
                        response_part_times: progress.map(({ at }) => at ?? null) },
                });
            }
            rows.push(message);
            continue;
        }
        const group = groups.get(message.id)!;
        if (group[0] !== message) continue;
        const saved = group.map((step) => savedSteps.get(step.id)!);
        const liveHere = group === liveGroup && running;
        const content = liveHere ? liveContent! : saved.at(-1)!;
        const prior = liveHere ? saved : saved.slice(0, -1);
        const attachments = [...new Map(saved.flatMap((step) => (step.attachments ?? []).map((a) => [a.id, a] as const))).values()];
        const view = foldResponseEntries(content, prior);
        const hasActivity = saved.some((step) => !!step.cli_activity?.length);
        if (!liveHere && !attachments.length && !view.answer.trim() && (!showProgress || (!view.progress.length && !hasActivity))) continue;
        assistants.set(message.id, { latest: group.at(-1)!, content, prior, attachments, live: liveHere,
            progressStart: number(message.turn_id, view.progress.length) });
        for (const step of group) anchors.set(step.seq, message.seq);
        rows.push(message);
    }
    return { rows, assistants, anchors, preceding, handlesLive: !!liveGroup,
        liveTail: liveContent && !running ? { content: liveContent, start: (counts.get(live!.turn_id) ?? 0) + 1 } : undefined };
}
