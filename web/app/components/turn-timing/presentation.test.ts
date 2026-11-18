import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimingBreakdown, TimingSummary } from "./TurnTiming";
import { saveTimingEnabled, TIMING_PREF_KEY, timingEnabled } from "./preference";

afterEach(() => vi.unstubAllGlobals());

describe("턴 시간 표시·설정", () => {
    function render(status: string, connected = true, detail = false, total = 12_345, showStatus = true) {
        return renderToStaticMarkup(createElement(detail ? TimingBreakdown : TimingSummary, {
            sample: { id: "turn", updated_at: "", receivedAt: 0, status,
                timing: { total_ms: total, approval_wait_ms: 3000, tool_ms: 1000, model_and_other_ms: 8000, running: status === "awaiting_approval" } },
            total, connected, showStatus,
        }));
    }

    it("승인·질문 대기를 실행 시간으로 부르지 않는다", () => {
        const html = render("awaiting_approval");
        expect(html).toContain("12초");
        expect(html).not.toMatch(/\d+\.\d+초/);
        expect(html).toContain('data-elapsed-ms="12345"');
        expect(html).not.toContain("총 경과");
        expect(html).toContain("승인·답변 대기");
        expect(render("awaiting_approval", true, true)).toContain("대기 포함");
        expect(html).not.toContain("모델·처리");
    });

    it.each(["completed", "interrupted", "failed", "cancelled"])("%s를 고정된 종료 시간으로 표시한다", (status) => {
        const html = render(status);
        expect(html).toContain('data-running="false"');
        expect(html).toContain("소요 시간");
        expect(html).not.toContain("승인 대기 3초");
        expect(html).not.toContain("도구 1초");
        const detail = render(status, true, true);
        expect(detail).toContain("마지막 요청 총 경과");
        expect(detail).toContain("승인 대기 3초");
        expect(detail).toContain("도구 1초");
        expect(detail).not.toMatch(/\d+\.\d+초/);
        if (status === "interrupted") expect(html).toContain("중단");
    });

    it("연결이 끊기면 마지막 확인 값이라고 명시한다", () => {
        expect(render("awaiting_approval", false)).toContain("연결 끊김·마지막 확인 값");
    });

    it.each([[65_000, "1m 5s"], [3_725_000, "1h 2m 5s"]] as const)("요약과 상세 모두 %dms를 %s로 표시한다", (total, text) => {
        expect(render("completed", true, false, total)).toContain(text);
        expect(render("completed", true, true, total)).toContain(text);
    });

    it("오류 카드 안에서는 실패 상태를 시간 옆에 반복하지 않는다", () => {
        const html = render("failed", true, false, 12_345, false);
        expect(html).toContain("소요 시간");
        expect(html).toContain("12초");
        expect(html).not.toContain("실패");
        expect(html).toContain("요청 시간 상세");
    });

    it("입력창 상태줄은 짧은 시간과 상세 진입점·연결 끊김 정보를 유지한다", () => {
        const html = renderToStaticMarkup(createElement(TimingSummary, {
            sample: { id: "turn", updated_at: "", receivedAt: 0, status: "awaiting_approval",
                timing: { total_ms: 28_000, approval_wait_ms: 0, tool_ms: 0, model_and_other_ms: 28_000, running: true } },
            total: 28_000, connected: false, compact: true, showStatus: false,
        }));
        expect(html).toContain("28초");
        expect(html).toContain("요청 시간 상세");
        expect(html).toContain("연결 끊김·마지막 확인 값");
        expect(html).not.toContain("경과 ");
        expect(html).not.toContain("승인·답변 대기");
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
