import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimingBreakdown, TimingSummary } from "./TurnTiming";
import { saveTimingEnabled, TIMING_PREF_KEY, timingEnabled } from "./preference";

afterEach(() => vi.unstubAllGlobals());

describe("턴 시간 표시·설정", () => {
    function render(status: string, connected = true, detail = false) {
        return renderToStaticMarkup(createElement(detail ? TimingBreakdown : TimingSummary, {
            sample: { id: "turn", updated_at: "", receivedAt: 0, status,
                timing: { total_ms: 12_000, approval_wait_ms: 3000, tool_ms: 1000, model_and_other_ms: 8000, running: status === "awaiting_approval" } },
            total: 12_000, connected,
        }));
    }

    it("승인·질문 대기를 실행 시간으로 부르지 않는다", () => {
        const html = render("awaiting_approval");
        expect(html).toContain("12.0초");
        expect(html).not.toContain("총 경과");
        expect(html).toContain("승인·답변 대기");
        expect(render("awaiting_approval", true, true)).toContain("대기 포함");
        expect(html).not.toContain("모델·처리");
    });

    it.each(["completed", "interrupted", "failed", "cancelled"])("%s를 고정된 종료 시간으로 표시한다", (status) => {
        const html = render(status);
        expect(html).toContain('data-running="false"');
        expect(html).toContain("요청");
        expect(html).not.toContain("승인 대기 3.0초");
        expect(html).not.toContain("도구 1.0초");
        const detail = render(status, true, true);
        expect(detail).toContain("마지막 요청 총 경과");
        expect(detail).toContain("승인 대기 3.0초");
        expect(detail).toContain("도구 1.0초");
        if (status === "interrupted") expect(html).toContain("중단");
    });

    it("연결이 끊기면 마지막 확인 값이라고 명시한다", () => {
        expect(render("awaiting_approval", false)).toContain("연결 끊김·마지막 확인 값");
    });

    it("설정을 저장·다시 읽고 알 수 없는 값은 기본 켜기로 읽는다", () => {
        const values = new Map<string, string>();
        vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
        const dispatchEvent = vi.fn();
        vi.stubGlobal("window", { dispatchEvent });
        expect(timingEnabled()).toBe(true);
        saveTimingEnabled(false);
        expect(timingEnabled()).toBe(false);
        saveTimingEnabled(true);
        expect(timingEnabled()).toBe(true);
        values.set(TIMING_PREF_KEY, "future-value");
        expect(timingEnabled()).toBe(true);
        expect(dispatchEvent).toHaveBeenCalledTimes(2);
    });

    it("저장 실패를 성공으로 숨기지 않는다", () => {
        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
        expect(timingEnabled()).toBe(true);
        expect(() => saveTimingEnabled(false)).toThrow("denied");
    });
});
