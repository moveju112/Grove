import type { ToolCallRow } from "../../api/generated";
import {
    acceptedDecisionResponse, approvalFailure, type ApprovalFailure, type ApprovalIdentity, type ApprovalRequest,
} from "./projection";

export type DecisionState =
    | { phase: "idle" }
    | { phase: "pending"; request: ApprovalRequest }
    | { phase: "settled"; call: ToolCallRow }
    | { phase: "failed"; failure: ApprovalFailure };

// 인스턴스 수명은 session/id/revision에 결합한다. render 전 연속 클릭도 동기적으로 차단한다.
export class ApprovalSubmission {
    private locked = false;
    private disposed = false;

    constructor(
        private identity: ApprovalIdentity,
        private publish: (state: DecisionState) => void,
    ) {}

    dispose() {
        this.disposed = true;
    }

    async submit(request: ApprovalRequest, send: (request: ApprovalRequest) => Promise<ToolCallRow>): Promise<void> {
        if (this.locked || this.disposed || request.id !== this.identity.id
            || request.session_id !== this.identity.session_id || request.revision !== this.identity.revision) return;
        this.locked = true;
        this.publish({ phase: "pending", request });
        try {
            const call = await send(request);
            if (!this.disposed) {
                this.publish(acceptedDecisionResponse(request, call)
                    ? { phase: "settled", call }
                    : { phase: "failed", failure: approvalFailure(null) });
            }
        } catch (error) {
            if (!this.disposed) this.publish({ phase: "failed", failure: approvalFailure(error) });
        }
        // 실패·응답 유실 후 재전송하지 않는다. 새 revision의 카드에서만 다시 판단한다.
    }
}
