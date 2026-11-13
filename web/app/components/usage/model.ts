export type UsageRow = {
    key: string;
    label: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens: number;
    reasoning_unreported_responses: number;
    responses: number;
    estimated_cost: { currency: string; amount: number }[];
    unpriced_tokens: number;
};

export type UsageReport = { rows: UsageRow[]; total: UsageRow; pricing_versions: string[] };
export type SortKey = "label" | "tokens" | "input_tokens" | "output_tokens" | "responses" | `cost:${string}`;
export type SortDirection = "asc" | "desc";

export const formatNumber = (n: number) => n.toLocaleString();
export const totalTokens = (row: UsageRow) => row.input_tokens + row.output_tokens;

/// cache는 입력, reasoning은 출력의 일부이므로 분모에 다시 더하지 않는다.
export function tokenShare(tokens: number, total: number): number | null {
    return total === 0 ? null : tokens / total;
}

export function formatShare(share: number | null): string {
    if (share === null) return "—";
    if (share > 0 && share < 0.001) return "0.1% 미만";
    return `${(share * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function formatCost(row: UsageRow): string {
    return row.estimated_cost.length === 0
        ? "가격 정보 없음"
        : row.estimated_cost.map(({ currency, amount }) =>
            `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`,
        ).join(" · ");
}

export function costCurrencies(report: UsageReport): string[] {
    return [...new Set([report.total, ...report.rows].flatMap((row) => row.estimated_cost.map((c) => c.currency)))].sort();
}

export function sortRows(rows: UsageRow[], key: SortKey, direction: SortDirection): UsageRow[] {
    const value = (row: UsageRow): string | number | undefined => {
        switch (key) {
            case "label": return row.label;
            case "tokens": return totalTokens(row);
            case "input_tokens": return row.input_tokens;
            case "output_tokens": return row.output_tokens;
            case "responses": return row.responses;
            default: return row.estimated_cost.find((c) => c.currency === key.slice(5))?.amount;
        }
    };
    return [...rows].sort((a, b) => {
        const av = value(a), bv = value(b);
        // 금액이 없는 행은 0으로 꾸미지 않고 어느 방향에서도 뒤에 둔다.
        if (av === undefined && bv !== undefined) return 1;
        if (av !== undefined && bv === undefined) return -1;
        const cmp = typeof av === "number" && typeof bv === "number"
            ? av - bv
            : typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, "ko") : 0;
        return cmp === 0 ? a.key.localeCompare(b.key, "ko") : cmp * (direction === "asc" ? 1 : -1);
    });
}
