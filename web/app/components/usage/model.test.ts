import { describe, expect, it } from "vitest";
import {
    costCurrencies, formatCost, formatShare, sortRows, tokenShare, totalTokens,
    type UsageRow,
} from "./model";

const row = (key: string, values: Partial<UsageRow> = {}): UsageRow => ({
    key, label: key, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    reasoning_tokens: 0, reasoning_unreported_responses: 0, responses: 0,
    estimated_cost: [], unpriced_tokens: 0, ...values,
});

describe("사용량 표현 변환", () => {
    it("cache와 reasoning을 총 token에 중복 합산하지 않는다", () => {
        const a = row("a", { input_tokens: 80, output_tokens: 20, cache_read_tokens: 40, reasoning_tokens: 5 });
        expect(totalTokens(a)).toBe(100);
        expect(tokenShare(totalTokens(a), 150)).toBeCloseTo(2 / 3);
        expect(tokenShare(a.input_tokens, totalTokens(a))).toBe(0.8);
        expect(tokenShare(0, 0)).toBeNull();
        expect(formatShare(null)).toBe("—");
        expect(formatShare(0)).toBe("0%");
        expect(formatShare(0.000001)).toBe("0.1% 미만");
    });

    it("알 수 없는 비용과 실제 0, 작은 비용, 통화별 금액을 구분한다", () => {
        expect(formatCost(row("unknown", { unpriced_tokens: 100 }))).toBe("가격 정보 없음");
        expect(formatCost(row("free", { estimated_cost: [{ currency: "USD", amount: 0 }] }))).toBe("0 USD");
        expect(formatCost(row("small", { estimated_cost: [{ currency: "USD", amount: 0.000001 }] }))).toBe("0.000001 USD");
        const multi = row("multi", { estimated_cost: [{ currency: "USD", amount: 2 }, { currency: "EUR", amount: 1 }] });
        expect(formatCost(multi)).toBe("2 USD · 1 EUR");
        expect(costCurrencies({ rows: [multi], total: row("total", { estimated_cost: [{ currency: "KRW", amount: 3 }] }), pricing_versions: [] }))
            .toEqual(["EUR", "KRW", "USD"]);
    });

    it("숫자 정렬·이름 정렬·동점 순서를 보장하고 원본은 바꾸지 않는다", () => {
        const rows = [row("c", { input_tokens: 2 }), row("b", { output_tokens: 10 }), row("a", { input_tokens: 10 })];
        expect(sortRows(rows, "tokens", "desc").map((r) => r.key)).toEqual(["a", "b", "c"]);
        expect(sortRows(rows, "tokens", "asc").map((r) => r.key)).toEqual(["c", "a", "b"]);
        expect(sortRows(rows, "label", "desc").map((r) => r.key)).toEqual(["c", "b", "a"]);
        expect(rows.map((r) => r.key)).toEqual(["c", "b", "a"]);
    });

    it("입력·출력·응답을 각 필드로 정렬한다", () => {
        const rows = [row("a", { input_tokens: 10, output_tokens: 1, responses: 2 }), row("b", { input_tokens: 1, output_tokens: 10, responses: 1 })];
        expect(sortRows(rows, "input_tokens", "desc").map((r) => r.key)).toEqual(["a", "b"]);
        expect(sortRows(rows, "output_tokens", "desc").map((r) => r.key)).toEqual(["b", "a"]);
        expect(sortRows(rows, "responses", "asc").map((r) => r.key)).toEqual(["b", "a"]);
    });

    it("통화를 합산하거나 환산하지 않고 미설정·다른 통화는 항상 마지막에 둔다", () => {
        const rows = [
            row("missing", { unpriced_tokens: 10 }),
            row("zero", { estimated_cost: [{ currency: "USD", amount: 0 }] }),
            row("eur", { estimated_cost: [{ currency: "EUR", amount: 999 }] }),
            row("paid", { estimated_cost: [{ currency: "USD", amount: 2 }, { currency: "EUR", amount: 1 }] }),
        ];
        expect(sortRows(rows, "cost:USD", "desc").map((r) => r.key)).toEqual(["paid", "zero", "eur", "missing"]);
        expect(sortRows(rows, "cost:USD", "asc").map((r) => r.key)).toEqual(["zero", "paid", "eur", "missing"]);
        expect(sortRows(rows, "cost:EUR", "desc").map((r) => r.key)).toEqual(["eur", "paid", "missing", "zero"]);
        expect(sortRows([], "tokens", "desc")).toEqual([]);
    });
});
