import { describe, expect, it } from "vitest";
import { recoveryLabel, type RecoveryItem } from "./RecoveryPanel";

const base: RecoveryItem = {
    kind: "turn", id: "t", session_id: "s", project_id: "p", session_title: "대화", archived: false,
    status: "interrupted", at: "2030-01-01T00:00:00Z", code: null, message: null, tool_name: null, turn_id: "t", evidence: null,
};

describe("미복구 기록 표시", () => {
    it("중단·실패 요청은 증거 보존·손상을 구분하고 성공으로 표시하지 않는다", () => {
        expect(recoveryLabel(base)).toBe("요청 중단");
        expect(recoveryLabel({ ...base, status: "failed", evidence: { text_chars: 12, tool_calls: 0 } })).toBe("요청 실패 · 확정 전 응답 12자 보존");
        expect(recoveryLabel({ ...base, evidence: { corrupt: true, kind: "hash_mismatch" } })).toBe("요청 중단 · 중단 증거 손상(원본 보존)");
    });
    it("결과 불명 도구는 도구 이름과 함께 표시한다", () => {
        expect(recoveryLabel({ ...base, kind: "tool_call", status: "unknown", tool_name: "shell" })).toBe("도구 shell 결과 불명");
    });
});
