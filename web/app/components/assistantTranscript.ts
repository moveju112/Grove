import type { Message } from "../api/generated";
import type { Attachment } from "../state/sendRecovery";
import { foldResponse, type ResponseContent } from "./AssistantResponse";

type LiveResponse = ResponseContent & { turn_id: string };
export type AssistantRow = {
    latest: Message;
    content: ResponseContent;
    prior: ResponseContent[];
    attachments: Attachment[];
    live: boolean;
};

/// 저장·페이지 경계는 원본 메시지에 유지하고, 화면에서만 턴의 어시스턴트 단계를 묶는다.
export function assistantTranscript(messages: readonly Message[], live?: LiveResponse, showProgress = true) {
    const turns = new Map<string, Message[]>();
    for (const message of messages) {
        if (message.role !== "assistant" || !message.turn_id) continue;
        const group = turns.get(message.turn_id);
        if (group) group.push(message);
        else turns.set(message.turn_id, [message]);
    }
    const rows: Message[] = [];
    const assistants = new Map<string, AssistantRow>();
    const anchors = new Map<number, number>();
    let handlesLive = false;
    for (const message of messages) {
        if (message.role === "tool") continue;
        if (message.role !== "assistant") {
            const type = (message.content as { type?: string }).type;
            if (message.role !== "note" || (type !== "cli_activity" && type !== "task_result")) rows.push(message);
            continue;
        }
        const group = message.turn_id ? turns.get(message.turn_id)! : [message];
        if (group[0] !== message) continue;
        const latest = group.at(-1)!;
        const saved = group.map((step) => step.content as ResponseContent & { attachments?: Attachment[] });
        const last = saved.at(-1)!;
        const sameLiveTurn = live !== undefined && live.turn_id === message.turn_id;
        handlesLive ||= sameLiveTurn;
        // 확정 답변 이벤트가 partial 지우기보다 먼저 도착해도 같은 답을 다시 넣지 않는다.
        const running = sameLiveTurn && (!!last.tool_calls?.length || !!last.pending_work);
        const content = running ? live : saved.at(-1)!;
        const prior = running ? saved : saved.slice(0, -1);
        const attachments = [...new Map(saved.flatMap((step) => (step.attachments ?? []).map((a) => [a.id, a] as const))).values()];
        const view = foldResponse(content, prior);
        if (!running && !attachments.length && !view.answer.trim() && (!showProgress || !view.progress.length)) continue;
        assistants.set(message.id, { latest, content, prior, attachments, live: running });
        for (const step of group) anchors.set(step.seq, message.seq);
        rows.push(message);
    }
    return { rows, assistants, anchors, handlesLive };
}
