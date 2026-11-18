import { describe, expect, it } from "vitest";
import type { Message } from "../api/generated";
import { foldResponse } from "./AssistantResponse";
import { assistantTranscript } from "./assistantTranscript";

const message = (seq: number, role: Message["role"], content: unknown, turn_id: string | null = "turn"): Message =>
    ({ id: `m${seq}`, seq, role, content, turn_id, session_id: "session", created_at: "2026-11-18T02:00:00Z" });
const attachment = { id: "image", name: "시안.png", project_id: "project", mime: "image/png", size: 42, stored: true };
const messages = [
    message(1, "user", { text: "확인해줘" }),
    message(2, "assistant", { text: "폴더부터 확인할게.", reasoning: "폴더 찾는 중", tool_calls: [{}], attachments: [attachment] }),
    message(3, "tool", { name: "list" }),
    message(4, "assistant", { reasoning: "레이아웃 검토 중", tool_calls: [{}] }),
    message(5, "note", { type: "task_result", command: "숨길 명령" }),
    message(6, "assistant", { text: "확인했어.", reasoning: "검증 완료", tool_calls: [], attachments: [attachment] }),
];

describe("한 요청의 어시스턴트 화면", () => {
    it("도구 기록과 추론 요약은 숨기고 진행 설명은 같은 답변에 묶는다", () => {
        const projection = assistantTranscript(messages);
        expect(projection.rows.map((m) => m.seq)).toEqual([1, 2]);
        expect(projection.anchors.get(4)).toBe(2);
        expect(projection.anchors.get(6)).toBe(2);
        const reply = projection.assistants.get("m2")!;
        expect(reply.latest.seq).toBe(6);
        expect(reply.attachments).toEqual([attachment]);
        expect(foldResponse(reply.content, reply.prior)).toEqual({
            answer: "확인했어.", progress: ["폴더부터 확인할게."],
        });
    });

    it("스트리밍과 확정 답변에도 행을 유지하고 늦게 지워진 partial을 중복하지 않는다", () => {
        const live = { turn_id: "turn", text: "확인했", reasoning: "검증 중" };
        const streaming = assistantTranscript(messages.slice(0, -1), live);
        expect(streaming.handlesLive).toBe(true);
        expect(streaming.rows.map((m) => m.seq)).toEqual([1, 2]);
        const row = streaming.assistants.get("m2")!;
        expect(row.live).toBe(true);
        expect(foldResponse(row.content, row.prior)).toEqual({ answer: "확인했", progress: ["폴더부터 확인할게."] });
        const finished = assistantTranscript(messages, live);
        expect(finished.handlesLive).toBe(true);
        expect(finished.assistants.get("m2")).toMatchObject({ live: false, content: { text: "확인했어." } });
    });

    it("추론만 있는 답변은 숨기고 첨부만 있는 다른 턴은 남긴다", () => {
        const other = message(7, "assistant", { attachments: [attachment] }, "other");
        const reasoningOnly = message(8, "assistant", { reasoning: "요약만 있음" }, "reasoning-only");
        const projection = assistantTranscript([...messages, other, reasoningOnly]);
        expect(projection.rows.map((m) => m.seq)).toEqual([1, 2, 7]);
    });

    it("진행 설명을 가리면 진행 설명만 있는 카드는 남기지 않는다", () => {
        const progress = message(7, "assistant", { text: "확인할게.", tool_calls: [{}] }, "other");
        expect(assistantTranscript([...messages, progress]).rows.map((m) => m.seq)).toEqual([1, 2, 7]);
        expect(assistantTranscript([...messages, progress], undefined, false).rows.map((m) => m.seq)).toEqual([1, 2]);
    });
});
