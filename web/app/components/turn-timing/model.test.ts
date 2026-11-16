import { afterEach, describe, expect, it, vi } from "vitest";
import { elapsedMs, seconds, startTimingTimer, type TimingSample } from "./model";

const sample = (running = true): TimingSample => ({
    receivedAt: 500,
    timing: { total_ms: 12_000, approval_wait_ms: 3000, tool_ms: 1000, model_and_other_ms: 8000, running },
});

afterEach(() => vi.useRealTimers());

describe("서버 기준 턴 시간", () => {
    it.each([-300_000, 0, 300_000])("기기 시계가 %dms 어긋나도 총 경과가 같다", (skew) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1) + skew));
        expect(elapsedMs(sample(), 2500, true)).toBe(14_000);
        vi.setSystemTime(Date.now() - 600_000);
        expect(elapsedMs(sample(), 3500, true)).toBe(15_000);
    });

    it("완료·재시작 후 종료 표본은 기기 시간과 무관하게 고정된다", () => {
        for (const now of [500, 10_000, 86_400_000]) expect(elapsedMs(sample(false), now, true)).toBe(12_000);
        expect(elapsedMs(sample(), 86_400_000, false)).toBe(12_000);
    });

    it("새 서버 조회로 복구하고 대기를 순수 실행으로 빼거나 중복 합산하지 않는다", () => {
        expect(elapsedMs({ ...sample(), receivedAt: 10_000 }, 11_000, true)).toBe(13_000);
        expect(elapsedMs(sample(), 100, true)).toBe(12_000);
        expect(seconds(12_345)).toBe("12초");
        expect(seconds(-1)).toBe("0초");
    });

    it.each([
        [-1, "0초"], [0, "0초"], [999, "0초"],
        [1000, "1초"], [1999, "1초"], [12_999, "12초"],
    ])("%dms는 소수점 없이 지난 정수 초인 %s로 표시한다", (ms, expected) => {
        expect(seconds(ms)).toBe(expected);
    });

    it("끄면 timer도 계산도 시작하지 않고 해제 뒤에는 갱신하지 않는다", () => {
        vi.useFakeTimers();
        const tick = vi.fn();
        startTimingTimer(false, tick)();
        expect(vi.getTimerCount()).toBe(0);
        expect(tick).not.toHaveBeenCalled();
        const stop = startTimingTimer(true, tick);
        vi.advanceTimersByTime(2000);
        expect(tick).toHaveBeenCalledTimes(3);
        stop();
        vi.advanceTimersByTime(10_000);
        expect(tick).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });
});
