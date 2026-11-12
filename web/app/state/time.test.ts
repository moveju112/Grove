import { describe, expect, it } from "vitest";
import { absoluteTime, displayTime, UNKNOWN_TIME } from "./time";

const afternoon = new Date(2026, 0, 12, 15, 4).toISOString();
const now = new Date(2026, 0, 12, 18, 4).getTime();
const relative = { clock: "24h", timeStyle: "relative" } as const;

describe("시각 표시 설정", () => {
    it("시계 형식은 24시간과 12시간을 구분하고 시스템이면 locale 기본을 따른다", () => {
        expect(absoluteTime(afternoon, { clock: "24h", timeStyle: "absolute" }, "time")).toMatch(/15/);
        expect(absoluteTime(afternoon, { clock: "24h", timeStyle: "absolute" }, "time")).not.toMatch(/AM|PM|오전|오후/);
        expect(absoluteTime(afternoon, { clock: "12h", timeStyle: "absolute" }, "time")).toMatch(/PM|오후/);
        expect(absoluteTime(afternoon, { clock: "system", timeStyle: "absolute" })).toBe(new Date(afternoon).toLocaleString());
    });
    it("상대 표시는 7일 이내 지난 시각에만 쓰고 미래·고정 시각은 절대 시각으로 둔다", () => {
        expect(displayTime(new Date(now - 30_000).toISOString(), relative, now)).toBe("방금 전");
        expect(displayTime(new Date(now + 30_000).toISOString(), relative, now)).toBe("방금 전");
        expect(displayTime(new Date(now - 5 * 60_000).toISOString(), relative, now)).toBe("5분 전");
        expect(displayTime(afternoon, relative, now)).toBe("3시간 전");
        expect(displayTime(new Date(now - 26 * 3_600_000).toISOString(), relative, now)).toBe("어제");
        const old = new Date(now - 8 * 86_400_000).toISOString();
        expect(displayTime(old, relative, now)).toBe(absoluteTime(old, relative));
        const later = new Date(now + 10 * 60_000).toISOString();
        expect(displayTime(later, relative, now)).toBe(absoluteTime(later, relative));
        expect(displayTime(afternoon, relative, now, { absolute: true, part: "time" })).toBe(absoluteTime(afternoon, relative, "time"));
    });
    it("잘못된 시각은 Invalid Date 대신 알 수 없음으로 표시한다", () => {
        expect(displayTime("", relative, now)).toBe(UNKNOWN_TIME);
        expect(absoluteTime("not-a-date", relative)).toBe(UNKNOWN_TIME);
    });
});
