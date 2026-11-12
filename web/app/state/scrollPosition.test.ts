import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDeviceCopies } from "./cleanup";
import { loadScrollPosition, parseScrollPosition, saveScrollPosition, SESSION_LIMIT } from "./scrollPosition";

const reading = { sessionId: "s", timelineRevision: 2, lastSeq: 180, atBottom: false, anchorSeq: 21, offset: -14.5 };

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        values,
        getItem: (k: string) => values.get(k) ?? null,
        setItem: (k: string, v: string) => void values.set(k, v),
        removeItem: (k: string) => void values.delete(k),
        key: (i: number) => [...values.keys()][i] ?? null,
        get length() { return values.size; },
    };
}

describe("parseScrollPosition", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("앱을 닫아 탭 저장소가 사라져도 대화별 마지막 위치는 기기에 남고 직접 로그아웃하면 지운다", () => {
        const device = memoryStorage();
        vi.stubGlobal("localStorage", device);
        vi.stubGlobal("sessionStorage", memoryStorage());
        saveScrollPosition("tab", reading);
        vi.stubGlobal("sessionStorage", memoryStorage()); // 앱 종료·process death
        expect(loadScrollPosition("new-tab", "s")).toEqual(reading);
        clearDeviceCopies(device as unknown as Storage);
        expect(loadScrollPosition("new-tab", "s")).toBeNull();
    });
    it("대화별 위치는 최근에 본 대화부터 상한까지만 보관한다", () => {
        const device = memoryStorage();
        vi.stubGlobal("localStorage", device);
        vi.stubGlobal("sessionStorage", memoryStorage());
        for (let i = 0; i <= SESSION_LIMIT; i++) saveScrollPosition(`t${i}`, { ...reading, sessionId: `s${i}` });
        saveScrollPosition("again", { ...reading, sessionId: "s1" });
        saveScrollPosition("next", { ...reading, sessionId: "fresh" });
        const kept = [...device.values.keys()].filter((k) => k.startsWith("grove.scroll.session."));
        expect(kept).toHaveLength(SESSION_LIMIT);
        expect(kept).toContain("grove.scroll.session.s1");
        expect(kept).toContain("grove.scroll.session.fresh");
        expect(kept).not.toContain("grove.scroll.session.s0");
    });
    it("닫은 탭을 최근 항목에서 다시 열 때는 대화의 마지막 위치를 쓰고 기존 탭의 위치는 덮어쓰지 않는다", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        vi.stubGlobal("sessionStorage", memoryStorage());
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
