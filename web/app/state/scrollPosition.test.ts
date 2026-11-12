import { afterEach, describe, expect, it, vi } from "vitest";
import { loadScrollPosition, parseScrollPosition, saveScrollPosition } from "./scrollPosition";

const reading = { sessionId: "s", timelineRevision: 2, lastSeq: 180, atBottom: false, anchorSeq: 21, offset: -14.5 };

describe("parseScrollPosition", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("닫은 탭을 최근 항목에서 다시 열 때는 대화의 마지막 위치를 쓰고 기존 탭의 위치는 덮어쓰지 않는다", () => {
        const values = new Map<string, string>();
        vi.stubGlobal("sessionStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
        saveScrollPosition("one", reading);
        saveScrollPosition("two", { ...reading, anchorSeq: 45 });
        expect(loadScrollPosition("one", "s")).toEqual(reading);
        expect(loadScrollPosition("new", "s")).toEqual({ ...reading, anchorSeq: 45 });
        expect(loadScrollPosition("new", "other")).toBeNull();
    });
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
