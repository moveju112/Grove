import { describe, expect, it } from "vitest";
import { messageOffsets, messageRange } from "./virtualMessages";

describe("가변 높이 메시지 범위", () => {
    it("측정한 높이를 보존하고 아직 보지 않은 행만 추정한다", () => {
        expect(messageOffsets([{ id: "a" }, { id: "b" }, { id: "c" }], new Map([["a", 40], ["b", 300]]), 20)).toEqual([0, 40, 340, 360]);
    });
    it("높이가 큰 행 내부와 정확한 경계에서 필요한 행만 고른다", () => {
        const offsets = [0, 40, 340, 360];
        expect(messageRange(offsets, 50, 100, 0)).toEqual({ start: 1, end: 2 });
        expect(messageRange(offsets, 340, 360, 0)).toEqual({ start: 2, end: 3 });
        expect(messageRange(offsets, 0, 40, 0)).toEqual({ start: 0, end: 1 });
    });
    it("빈 목록과 바깥 viewport를 처리하며 overscan도 목록 길이를 넘지 않는다", () => {
        expect(messageRange([0], 0, 500)).toEqual({ start: 0, end: 0 });
        expect(messageRange([0, 40, 80], -500, -200, 1)).toEqual({ start: 0, end: 2 });
        expect(messageRange([0, 40, 80], 100, 500, 0)).toEqual({ start: 1, end: 2 });
    });
    it("목록이 커져도 viewport 주변 행 수는 전체 길이에 비례하지 않는다", () => {
        const offsets = Array.from({ length: 10001 }, (_, i) => i * 100);
        expect(messageRange(offsets, 500000, 500600)).toEqual({ start: 4992, end: 5014 });
    });
});
