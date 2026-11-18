import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AutosaveStatus } from "./AutosaveStatus";
import { APPLIES } from "./constants";

type State = ComponentProps<typeof AutosaveStatus>["state"];
function render(overrides: Partial<State> = {}, applies = APPLIES.next_turn) {
    const state: State = {
        value: "value", revision: 1, dirty: false, phase: "idle", canRebase: false, canRetry: false,
        useRemote: vi.fn(), applyMine: vi.fn(), retry: vi.fn(), ...overrides,
    };
    const html = renderToStaticMarkup(createElement(AutosaveStatus, { state, applies }));
    return { html, text: html.replace(/<[^>]*>/g, "") };
}

describe("간결한 자동 저장 안내", () => {
    it("변경 전에는 안내를 표시하지 않고 입력 중에만 미저장을 표시한다", () => {
        expect(render().text).toBe("");
        expect(render({ dirty: true }).text).toBe("저장 안 됨");
    });

    it("저장 중에는 미저장 문구를 중복 표시하지 않는다", () => {
        expect(render({ dirty: true, phase: "saving" }).text).toBe("저장 중…");
    });

    it("저장 완료는 짧게 표시하고 적용 시점은 접근성 설명에 유지한다", () => {
        const { text, html } = render({ phase: "saved" });
        expect(text).toBe("저장됨");
        expect(html).toContain(`aria-description="${APPLIES.next_turn}"`);
        expect(render({ phase: "saved" }, APPLIES.restart).text).toBe(`저장됨 · ${APPLIES.restart}`);
    });

    it("저장 실패에는 기존 값 유지와 재시도 경로를 남긴다", () => {
        const { text } = render({ dirty: true, phase: "error", message: "연결 오류", canRetry: true });
        expect(text).toContain("저장 실패(기존 값 유지): 연결 오류");
        expect(text).toContain("다시 시도");
        expect(text).not.toContain("저장 안 됨");
    });

    it("충돌·결과 불명 안내와 복구 동작을 유지한다", () => {
        const conflict = render({ dirty: true, phase: "conflict", canRebase: true }).text;
        expect(conflict).toContain("내 입력은 보존했어요");
        expect(conflict).toContain("최신 값 사용");
        expect(conflict).toContain("내 수정 적용");
        const uncertain = render({ dirty: true, phase: "uncertain" }).text;
        expect(uncertain).toContain("저장 결과를 확인하지 못했어요");
        expect(uncertain).toContain("요청 결과 확인");
    });
});
