import { describe, expect, it } from "vitest";
import type { PushTest } from "../api/generated";
import { pushTestMessage } from "./PushNotificationTests";

const receipt: PushTest = { id: "test-id", state: "queued", error: null, created_at: "2026-11-16T00:00:00Z", scheduled_at: "2026-11-16T00:00:10Z" };
describe("실제 Push 시험 결과 문구", () => {
    it("접수·재시도·서비스 수락을 실제 기기 표시와 구분한다", () => {
        expect(pushTestMessage(receipt)).toContain("전송 대기");
        expect(pushTestMessage({ ...receipt, error: "push_network_unavailable" })).toContain("재시도 대기 (push_network_unavailable)");
        expect(pushTestMessage({ ...receipt, state: "sent" })).toBe("Push 서비스가 전송을 수락했어. 실제 알림 도착·소리·진동은 폰에서 확인해줘.");
    });
    it("실패는 구체적인 전송 오류를 표시한다", () => {
        expect(pushTestMessage({ ...receipt, state: "failed", error: "push_service_denied" })).toBe("Push 전송 실패 (push_service_denied).");
        expect(pushTestMessage({ ...receipt, state: "failed" })).toContain("원인 미확인");
    });
});
