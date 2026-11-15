import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "./CodeBlock";

describe("읽기 전용 원문 표시", () => {
    it("로그 안의 HTML은 글자로만 표시하고 기본 조작을 추가하지 않는다", () => {
        const html = renderToStaticMarkup(createElement(CodeBlock, { code: "<script>unsafe()</script>" }));
        expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
        expect(html).not.toMatch(/<(script|button|input|textarea)\b/);
    });
    it("누락된 출력에 예제나 상태 문구를 만들어 넣지 않는다", () => {
        const html = renderToStaticMarkup(createElement(CodeBlock, { code: undefined }));
        expect(html).not.toContain("undefined");
        expect(html).not.toMatch(/<(button|input|textarea)\b/);
    });
});
