import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TokenDonut, UsagePresentation } from "./UsagePresentation";
import type { UsageRow } from "./model";

const total: UsageRow = {
    key: "total", label: "합계", input_tokens: 80, output_tokens: 20, cache_read_tokens: 40,
    reasoning_tokens: 5, reasoning_unreported_responses: 1, responses: 2,
    estimated_cost: [{ currency: "USD", amount: 0 }], unpriced_tokens: 50,
};

describe("사용량 텍스트 대체", () => {
    it("도넛 색을 보지 않아도 종류별 값·비율·분모를 읽을 수 있다", () => {
        const html = renderToStaticMarkup(createElement(TokenDonut, { total }));
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain("입력 80 tokens · 80%");
        expect(html).toContain("출력 20 tokens · 20%");
        expect(html).toContain("분모: 입력+출력 100 tokens");
        expect(html).toContain('stroke-dasharray="80 100"');
    });

    it("0 token은 계산 불가로, 미보고와 가격 미설정은 별도로 표시한다", () => {
        const zero = renderToStaticMarkup(createElement(TokenDonut, { total: { ...total, input_tokens: 0, output_tokens: 0 } }));
        expect(zero).toContain("총 token이 0이라 비율을 계산하지 않습니다.");
        expect(zero).not.toContain("NaN");
        const html = renderToStaticMarkup(createElement(UsagePresentation, { report: { rows: [total], total, pricing_versions: [] }, groupLabel: "모델" }));
        expect(html).toContain("보고된 reasoning 5 tokens(출력에 포함)");
        expect(html).toContain("미보고 응답 1개");
        expect(html).toContain("가격 미설정 50 tokens(비용에 포함 안 됨)");
        expect(html).toContain("0 USD");
        expect(html).toContain('scope="row"');
        expect(html).toContain('aria-label="정렬 기준"');
        const unreported = { ...total, reasoning_tokens: 0, reasoning_unreported_responses: 2 };
        const missing = renderToStaticMarkup(createElement(UsagePresentation, { report: { rows: [unreported], total: unreported, pricing_versions: [] }, groupLabel: "모델" }));
        expect(missing).toContain("reasoning: 보고된 값 없음");
        expect(missing).not.toContain("보고된 reasoning 0 tokens");
    });
});
