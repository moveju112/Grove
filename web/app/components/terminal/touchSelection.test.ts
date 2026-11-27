import { describe, expect, it } from "vitest";
import { cellAt, selectionRange } from "./touchSelection";

describe("터치 선택 좌표", () => {
    const box = { left: 10, top: 20, width: 800, height: 240 }; // 80열 x 24행, 셀 10x10

    it("화면 좌표를 스크롤 위치가 반영된 버퍼 셀로 바꾼다", () => {
        expect(cellAt(box, 80, 24, 100, 10 + 35, 20 + 47)).toEqual({ col: 3, row: 104 });
    });

    it("터미널 밖 좌표는 가장자리 셀로 맞춘다", () => {
        expect(cellAt(box, 80, 24, 0, -50, -50)).toEqual({ col: 0, row: 0 });
        expect(cellAt(box, 80, 24, 7, 5000, 5000)).toEqual({ col: 79, row: 30 });
    });

    it("두 셀 사이를 순서와 관계없이 양끝 포함 길이로 만든다", () => {
        expect(selectionRange({ col: 2, row: 5 }, { col: 6, row: 5 }, 80)).toEqual({ column: 2, row: 5, length: 5 });
        expect(selectionRange({ col: 1, row: 7 }, { col: 78, row: 5 }, 80)).toEqual({ column: 78, row: 5, length: 2 * 80 + 1 - 78 + 1 });
    });
});
