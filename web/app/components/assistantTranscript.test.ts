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

    const steer = (seq: number, id: string) => message(seq, "user", { text: "추가 지시", source: { kind: "steer", followup_id: id } });

    it("합치기 전후의 별도 모델 호출을 사용자 메시지 양쪽에 놓는다", () => {
        const front = [messages[0]!, messages[1]!, steer(3, "merge")];
        const live = { turn_id: "turn", response_parts: ["다시 확인할게.", "새 답변"] };
        const running = assistantTranscript(front, live);
        expect(running.rows.map((m) => m.seq)).toEqual([1, 2, 3]);
        expect(running.assistants.get("m2")?.live).toBe(false);
        expect(running.liveTail).toMatchObject({ start: 2, content: live });
        const saved = assistantTranscript([...front, message(4, "assistant", live)], live);
        expect(saved.rows.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
        expect(saved.anchors.get(4)).toBe(4);
        expect(saved.liveTail).toBeUndefined();
        expect(saved.assistants.get("m4")).toMatchObject({ progressStart: 2, content: live });
    });

    it("native 합치기 경계마다 진행을 나누고 번호와 시각을 유지한다", () => {
        const front = [messages[0]!, steer(2, "first"), steer(3, "second"), steer(4, "empty")];
        const content = { response_parts: ["하나", "둘", "", "셋", "넷", "답변"],
            response_part_times: ["t1", "t2", null, "t3", "t4", "t5"],
            response_steers: [["first", 2], ["second", 4], ["empty", 4]] as [string, number][] };
        const live = { turn_id: "turn", ...content };
        const during = assistantTranscript(front, live);
        const after = assistantTranscript([...front, message(5, "assistant", content)], live);
        for (const view of [during, after]) {
            expect(view.preceding.get("m2")).toMatchObject({ start: 1, content: { response_parts: ["하나", "둘"], response_part_times: ["t1", "t2"] } });
            expect(view.preceding.get("m3")).toMatchObject({ start: 3, content: { response_parts: ["셋"], response_part_times: ["t3"] } });
            expect(view.preceding.has("m4")).toBe(false);
        }
        expect(during.liveTail).toMatchObject({ start: 4, content: { response_parts: ["넷", "답변"] } });
        expect(after.liveTail).toBeUndefined();
        expect(after.assistants.get("m5")).toMatchObject({ progressStart: 4, content: { response_parts: ["넷", "답변"] } });
    });

    it("경계가 없는 예전 응답은 추정해서 분리하지 않고 최종 답변을 합친 메시지 뒤에 둔다", () => {
        const saved = assistantTranscript([messages[0]!, steer(2, "merge"), message(3, "assistant", { response_parts: ["진행", "답변"] })]);
        expect(saved.rows.map((m) => m.seq)).toEqual([1, 2, 3]);
        expect(saved.preceding.size).toBe(0);
        expect(saved.assistants.get("m3")?.content.response_parts).toEqual(["진행", "답변"]);
    });
});
