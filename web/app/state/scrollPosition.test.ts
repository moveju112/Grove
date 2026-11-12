import { describe, expect, it } from "vitest";
import { parseScrollPosition } from "./scrollPosition";

const reading = { sessionId: "s", timelineRevision: 2, lastSeq: 180, atBottom: false, anchorSeq: 21, offset: -14.5 };

describe("parseScrollPosition", () => {
    it("음수 offset을 포함한 읽던 메시지 위치를 보존한다", () => {
        expect(parseScrollPosition(JSON.stringify(reading), "s")).toEqual(reading);
    });
    it("맨 아래 위치에는 존재하지 않는 anchor를 요구하지 않는다", () => {
        const bottom = { ...reading, lastSeq: 0, atBottom: true, anchorSeq: null, offset: 0 };
        expect(parseScrollPosition(JSON.stringify(bottom), "s")).toEqual(bottom);
    });
    it("다른 대화·손상된 JSON·잘못된 seq와 timeline을 인수하지 않는다", () => {
        expect(parseScrollPosition(JSON.stringify(reading), "other")).toBeNull();
        expect(parseScrollPosition("{", "s")).toBeNull();
        for (const patch of [{ timelineRevision: -1 }, { lastSeq: "180" }, { anchorSeq: 181 }, { anchorSeq: 1.5 }, { offset: null }]) {
            expect(parseScrollPosition(JSON.stringify({ ...reading, ...patch }), "s")).toBeNull();
        }
    });
});
