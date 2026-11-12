import { describe, expect, it } from "vitest";
import { queueText } from "./queue";

describe("대기 이유 문구", () => {
    it("한도 종류·활성 수·앞선 요청 수를 보여 준다", () => {
        expect(queueText({ ahead: 2, active: 1, limit: 1 })).toBe("실행 차례를 기다리는 중 · 동시 실행 1/1 · 앞에 2개");
        expect(queueText({ ahead: 0, active: 2, limit: 2, reason: "account" })).toBe("실행 차례를 기다리는 중 · 계정 한도 2/2");
        expect(queueText({ ahead: 0, active: 3, limit: 3, reason: "provider" })).toBe("실행 차례를 기다리는 중 · 공급자 한도 3/3");
    });
});
