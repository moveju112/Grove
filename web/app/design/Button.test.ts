import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("공용 Astryx 버튼의 native 계약", () => {
    it("기본 폼 제출과 명시한 취소 버튼 유형을 보존한다", () => {
        const submit = renderToStaticMarkup(createElement(Button, { children: "저장" }));
        const cancel = renderToStaticMarkup(createElement(Button, { type: "button", children: "취소" }));
        expect(submit).toMatch(/^<button\b[^>]*\btype="submit"/);
        expect(cancel).toMatch(/^<button\b[^>]*\btype="button"/);
    });
    it("hydration 전에도 비활성화와 접근성 설명을 제공한다", () => {
        const html = renderToStaticMarkup(createElement(Button, {
            disabled: true, "aria-label": "서버 작업", "aria-description": "오프라인", children: "실행",
        }));
        expect(html).toContain('disabled=""');
        expect(html).toContain('aria-disabled="true"');
        expect(html).toContain('aria-label="서버 작업"');
        expect(html).toContain('aria-description="오프라인"');
    });
    it.each(["icon", "send"] as const)("아이콘 전용 %s 버튼도 접근성 이름·유형·비활성화를 유지한다", (appearance) => {
        const html = renderToStaticMarkup(createElement(Button, {
            appearance, type: "button", disabled: true, "aria-label": "아이콘 작업",
            children: createElement("svg", { viewBox: "0 0 24 24", "aria-hidden": true },
                createElement("path", { d: "M3 3h18v18H3z" })),
        }));
        expect(html).toMatch(/^<button\b[^>]*\btype="button"/);
        expect(html).toContain('aria-label="아이콘 작업"');
        expect(html).toContain('disabled=""');
        expect(html).toContain('aria-disabled="true"');
        expect(html.match(/<svg\b/g)).toHaveLength(1);
        expect(html).not.toContain(">아이콘 작업<");
    });
});
