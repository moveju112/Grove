import { describe, expect, it } from "vitest";
import { runLabel } from "./AgentRunsPanel";

describe("자식 작업 상태 표시", () => {
    it("진행 중이면 자식 턴의 대기 상태를 보여 주고 사용자 확인이 필요한지 구분한다", () => {
        expect(runLabel({ status: "running", turn_status: "awaiting_input" })).toEqual({ text: "답변 대기", needsUser: true });
        expect(runLabel({ status: "running", turn_status: "awaiting_approval" })).toEqual({ text: "승인 대기", needsUser: true });
        expect(runLabel({ status: "running", turn_status: "queued" })).toEqual({ text: "시작 대기", needsUser: false });
        expect(runLabel({ status: "running", turn_status: "running" })).toEqual({ text: "진행 중", needsUser: false });
    });
    it("끝난 작업은 마지막 턴 상태와 무관하게 종료 상태를 보여 준다", () => {
        expect(runLabel({ status: "failed", turn_status: "failed" })).toEqual({ text: "실패", needsUser: false });
        expect(runLabel({ status: "cancelled", turn_status: "awaiting_input" })).toEqual({ text: "취소됨", needsUser: false });
        expect(runLabel({ status: "completed", turn_status: null })).toEqual({ text: "완료", needsUser: false });
    });
});
