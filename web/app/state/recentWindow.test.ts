import { describe, expect, it } from "vitest";
import { effectiveRecentWindow, groupBySplit, normalizeRecentWindows, recentSince, recentWindowLabel } from "./recentWindow";

describe("최근 항목 시간 범위(원본 최근 탭 기준)", () => {
    it("선택지는 순서대로 최대 3개, 비거나 잘못되면 기본 30분·4시간·12시간", () => {
        expect(normalizeRecentWindows(["12h", "15m", "12h", "today", "1h"])).toEqual(["15m", "1h", "12h"]);
        expect(normalizeRecentWindows([])).toEqual(["30m", "4h", "12h"]);
        expect(normalizeRecentWindows(["bogus", 3])).toEqual(["30m", "4h", "12h"]);
    });
    it("목록에서 빠진 선택은 더 넓은 첫 범위로 바꾼다", () => {
        expect(effectiveRecentWindow("2h", ["30m", "4h", "12h"])).toBe("4h");
        expect(effectiveRecentWindow("today", ["30m", "4h"])).toBe("4h");
        expect(effectiveRecentWindow("30m", ["30m"])).toBe("30m");
    });
    it("하한은 분 단위로 내리고 오늘은 이 기기 자정이다", () => {
        const now = new Date(2026, 0, 12, 15, 4, 31);
        expect(recentSince("30m", now)).toBe(new Date(2026, 0, 12, 14, 34).toISOString());
        expect(recentSince("today", now)).toBe(new Date(2026, 0, 12).toISOString());
        expect(recentWindowLabel("30m")).toBe("30분");
        expect(recentWindowLabel("4h")).toBe("4시간");
    });
    it("분할로 함께 연 대화는 가장 최근 항목 아래로 모으고 다른 항목 순서는 유지한다", () => {
        const items = ["a", "f", "b", "c"].map((id) => ({ kind: id === "f" ? "file" : "session", resource_id: id }));
        const grouped = groupBySplit(items, new Set(["c", "a", "f"]));
        expect(grouped.map((g) => [g.item.resource_id, g.linked.map((x) => x.resource_id)])).toEqual([["a", ["c"]], ["f", []], ["b", []]]);
        expect(groupBySplit(items, new Set(["b"])).every((g) => g.linked.length === 0)).toBe(true);
    });
});
