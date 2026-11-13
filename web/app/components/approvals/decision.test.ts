import { describe, expect, it, vi } from "vitest";
import type { ToolCallRow } from "../../api/generated";
import { ApprovalSubmission, type DecisionState } from "./decision";
import { approvalFixture } from "./fixtures.test-support";
import type { ApprovalRequest } from "./projection";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const call = approvalFixture();
const request: ApprovalRequest = { id: call.id, session_id: call.session_id, revision: call.revision, decision: "approve" };

describe("승인 전송 수명", () => {
    it("빠른 중복 클릭과 승인·거부 경합에서 정확히 한 요청만 보낸다", async () => {
        const reply = deferred<ToolCallRow>();
        const send = vi.fn(() => reply.promise);
        const states: DecisionState[] = [];
        const gate = new ApprovalSubmission(call, (s) => states.push(s));
        const first = gate.submit(request, send);
        await gate.submit({ ...request, decision: "deny" }, send);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(request);
        expect(states).toEqual([{ phase: "pending", request }]);
        reply.resolve({ ...call, status: "approved", revision: 2 });
        await first;
        expect(states.at(-1)).toMatchObject({ phase: "settled", call: { status: "approved" } });
        await gate.submit(request, send);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("실패·응답 유실 후 선택을 바꾸거나 자동 재전송하지 않는다", async () => {
        const send = vi.fn().mockRejectedValue(new TypeError("transport lost"));
        const publish = vi.fn();
        const gate = new ApprovalSubmission(call, publish);
        await gate.submit(request, send);
        await gate.submit({ ...request, decision: "deny" }, send);
        expect(send).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "failed", failure: expect.objectContaining({ kind: "unknown" }) }));
    });

    it.each(["id", "session_id", "revision"] as const)("다른 %s의 전송은 차단한다", async (field) => {
        const send = vi.fn();
        const publish = vi.fn();
        const gate = new ApprovalSubmission(call, publish);
        await gate.submit({ ...request, [field]: field === "revision" ? 2 : "other" }, send);
        expect(send).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it.each(["resolve", "reject"] as const)("교체·unmount 후 늦은 %s는 다른 카드 상태를 바꾸지 않는다", async (outcome) => {
        const reply = deferred<ToolCallRow>();
        const publish = vi.fn();
        const gate = new ApprovalSubmission(call, publish);
        const first = gate.submit(request, () => reply.promise);
        gate.dispose();
        if (outcome === "resolve") reply.resolve({ ...call, status: "approved", revision: 2 });
        else reply.reject(new Error("late failure"));
        await first;
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith({ phase: "pending", request });
        const nextPublish = vi.fn();
        const next = new ApprovalSubmission({ ...call, id: "next" }, nextPublish);
        await next.submit({ ...request, id: "next" }, async () => ({ ...call, id: "next", status: "denied", revision: 2 }));
        expect(nextPublish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "settled", call: expect.objectContaining({ id: "next", status: "denied" }) }));
    });

    it("다른 요청 또는 같은 revision의 응답을 확정 결과로 채택하지 않는다", async () => {
        for (const response of [{ ...call, id: "other", revision: 2, status: "approved" }, { ...call, status: "approved" }]) {
            const publish = vi.fn();
            await new ApprovalSubmission(call, publish).submit(request, async () => response);
            expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "failed", failure: expect.objectContaining({ kind: "unknown" }) }));
        }
    });
});
