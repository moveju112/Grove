import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";
import { approvalFixture } from "./fixtures.test-support";
import { currentApprovalContract } from "./projection";

function render(overrides: Partial<ApprovalCardProps> = {}) {
    const call = overrides.call ?? approvalFixture();
    return renderToStaticMarkup(createElement(ApprovalCard, {
        call, ...currentApprovalContract(call.name), onDecision: async () => call, ...overrides,
    }));
}

describe("승인 카드 표현", () => {
    it("대상·부작용·넓은 대화 허용 범위·거부·알림을 표시한다", () => {
        const html = render();
        for (const text of ["note.txt", "생성·수정·삭제", "도구 전체", "이 대화에서 승인", "거부", 'role="status"', "aria-labelledby=", "aria-describedby="]) {
            expect(html).toContain(text);
        }
        expect(html).not.toContain("not-for-display");
    });

    it("agent 위임만 대화 전체 승인에서 제외한다", () => {
        const html = render({ call: approvalFixture({ name: "agent" }) });
        expect(html).not.toContain("이 대화에서 승인");
        expect(html).toContain("이번만 승인");
    });

    it("PC 제어는 짧은 범위 안내와 대화 승인을 먼저 표시한다", () => {
        const html = render({ call: approvalFixture({ name: "computer", target: {
            action: "act", window_id: "46137423", frame_id: "frame-private", actions: [{ type: "click", x: 168, y: 32 }],
        } }) });
        expect(html).toContain("PC 제어 승인 요청");
        expect(html).toContain("서버 PC 화면 공유·조작을 이 대화에서 계속 허용합니다.");
        expect(html.indexOf("이 대화에서 승인")).toBeLessThan(html.indexOf("이번만 승인"));
        for (const text of ["revision", "승인 기한", "46137423", "frame-private", "부작용", "비밀값 보호", "입력 내용은 표시하지 않습니다", "허용 범위:"]) {
            expect(html).not.toContain(text === "revision" ? "· revision" : text);
        }
        expect(html).not.toContain('data-testid="approval-target"');
    });

    it.each(["expired", "denied", "failed", "unknown", "approved", "running", "succeeded", "cancelled"])("%s에서 재승인을 막고 상태를 구분한다", (status) => {
        const html = render({ call: approvalFixture({ status }) });
        expect(html.match(/disabled=""/g)).toHaveLength(3);
        if (status === "unknown") expect(html).toContain("결과 불명");
        if (status === "approved") expect(html).toContain("실행 전");
        if (status === "running") expect(html).toContain("결과 미확정");
    });

    it("만료 시각과 권한 차단을 승인 완료처럼 표시하지 않는다", () => {
        const expired = render({ call: approvalFixture({ expires_at: "2000-01-01T00:00:00Z" }) });
        expect(expired).toContain("승인 만료");
        expect(expired.match(/disabled=""/g)).toHaveLength(3);
        const blocked = render({ call: approvalFixture({ status: "failed", result: { error: { code: "read_only", message: "private-message" } } }) });
        expect(blocked).toContain('role="alert"');
        expect(blocked).toContain("권한 또는 도구 정책");
        expect(blocked).not.toContain("private-message");
    });

    it("외부 pending/error도 같은 identity에서만 적용한다", () => {
        const identity = { id: "call-1", session_id: "session-1", revision: 1 };
        expect(render({ feedback: { ...identity, phase: "pending" } })).toContain('aria-busy="true"');
        expect(render({ feedback: { ...identity, id: "other", phase: "pending" } })).toContain('aria-busy="false"');
        const html = render({ feedback: { ...identity, phase: "failed", failure: { kind: "permission", message: "권한 거부" } } });
        expect(html).toContain("권한 거부");
        expect(html).toContain('role="alert"');
        expect(html.match(/disabled=""/g)).toHaveLength(3);
    });
});
