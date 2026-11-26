import { describe, expect, it } from "vitest";
import { absoluteTime, displayTime, serverTimeZone, UNKNOWN_TIME } from "./time";

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
    it("분 단위 시각은 시계 설정을 유지하고 초만 생략한다", () => {
        const at = new Date(2026, 0, 12, 15, 4, 59).toISOString();
        expect(displayTime(at, relative, now, { absolute: true, part: "minute" })).toBe("15:04");
        expect(absoluteTime(at, { ...relative, clock: "12h" }, "minute")).toMatch(/3:04/);
        expect(absoluteTime(at, { ...relative, clock: "12h" }, "minute")).not.toContain(":59");
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
    it("최근의 짧은 표시는 가장 큰 단위만 남기고 내림한다", () => {
        for (const [elapsed, expected] of [
            [-30_000, "0m"], [30_000, "0m"], [60_000, "1m"], [3_599_999, "59m"],
            [3_600_000, "1h"], [80 * 60_000, "1h"], [86_399_999, "23h"],
            [86_400_000, "1d"], [8 * 86_400_000, "8d"],
        ] as const) {
            expect(displayTime(new Date(now - elapsed).toISOString(), relative, now, { compact: true })).toBe(expected);
        }
        const future = new Date(now + 10 * 60_000).toISOString();
        expect(displayTime(future, relative, now, { compact: true })).toBe(absoluteTime(future, relative));
        expect(displayTime("", relative, now, { compact: true })).toBe(UNKNOWN_TIME);
    });
    it("잘못된 시각은 Invalid Date 대신 알 수 없음으로 표시한다", () => {
        expect(displayTime("", relative, now)).toBe(UNKNOWN_TIME);
        expect(absoluteTime("not-a-date", relative)).toBe(UNKNOWN_TIME);
    });
    it("오류 시각은 서버 시간대로 날짜 경계를 넘겨 표시하고 시간대가 없으면 UTC를 쓴다", () => {
        const at = "2026-11-25T22:31:39.430958164Z";
        const seoul = serverTimeZone("Asia/Seoul");
        expect(absoluteTime(at, relative, "datetime", seoul)).toBe(new Date("2026-11-25T22:31:39.430Z")
            .toLocaleString(undefined, { hour12: false, timeZone: "Asia/Seoul", timeZoneName: "short" }));
        expect(absoluteTime(at, relative, "datetime", seoul)).not.toBe(absoluteTime(at, relative, "datetime", "UTC"));
        expect(serverTimeZone(undefined)).toBe("UTC");
        expect(serverTimeZone("Invalid/Time_Zone")).toBe("UTC");
    });
});
