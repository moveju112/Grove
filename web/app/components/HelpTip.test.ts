import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SentenceText } from "./HelpTip";

describe("안내문 문장 줄바꿈", () => {
    it("문장 경계에서만 줄을 나누고 URL·버전·소수점은 유지한다", () => {
        const html = renderToStaticMarkup(createElement(SentenceText, { text: "먼저 입력하세요. https://example.test/a.b · v1.2.3 · 0.5를 확인하세요. 다시 시도하세요." }));
        expect(html).toBe('<span class="sentence-lines"><span>먼저 입력하세요.</span><span>https://example.test/a.b · v1.2.3 · 0.5를 확인하세요.</span><span>다시 시도하세요.</span></span>');
    });
});
