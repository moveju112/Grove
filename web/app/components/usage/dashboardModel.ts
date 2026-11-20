import type { UsageDashboard, UsageMetrics, UsageSlice } from "../../api/generated";

export const providerName = (protocol: string) => ({ codex_cli: "Codex CLI", codex_oauth: "Codex", claude_code: "Claude", openai: "OpenAI API", anthropic: "Anthropic API", gemini: "Gemini API", unknown: "공급자 미기록" }[protocol] ?? protocol);
export const tokens = (metrics: Pick<UsageMetrics, "input_tokens" | "output_tokens">) => metrics.input_tokens + metrics.output_tokens;
export const freshInput = (metrics: UsageMetrics) => Math.max(0, metrics.input_tokens - metrics.cache_read_tokens - metrics.cache_write_tokens);
export const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
export const compact = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(Math.round(value));
export const speed = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1);
export const cacheHit = (metrics: UsageMetrics) => metrics.input_tokens > 0 && metrics.unreported_responses === 0
    ? `${(metrics.cache_read_tokens / metrics.input_tokens * 100).toFixed(1)}%` : "—";
export type Group = "models" | "projects" | "agents" | "workflows" | "sessions" | "efforts";
export type Sort = "tokens" | "speed";

export function sortedRows(report: UsageDashboard, group: Group, sort: Sort, provider: string) {
    return report[group].filter((row) => provider === "all" || row.provider === provider).slice().sort((a, b) => {
        const av = sort === "tokens" ? tokens(a.metrics) : a.metrics.tok_per_second;
        const bv = sort === "tokens" ? tokens(b.metrics) : b.metrics.tok_per_second;
        if (av === null) return bv === null ? a.key.localeCompare(b.key) : 1;
        if (bv === null) return -1;
        return bv - av || a.key.localeCompare(b.key);
    });
}

export function providerRows(rows: UsageSlice[]): UsageSlice[] {
    return [...rows].sort((a, b) => {
        const rank = (key: string) => key === "codex_cli" ? 0 : key === "claude_code" ? 1 : 2;
        return rank(a.provider) - rank(b.provider) || tokens(b.metrics) - tokens(a.metrics);
    });
}

export type Period = "1h" | "8h" | "24h" | "7d" | "30d" | "custom";
export function usageRange(period: Period, start: string, end: string, now = new Date()) {
    let from: Date;
    let to = now;
    if (period === "custom") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
        from = new Date(`${start}T00:00:00`);
        to = new Date(`${end}T00:00:00`);
        const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        if (localDate(from) !== start || localDate(to) !== end) return null;
        to.setDate(to.getDate() + 1);
    } else {
        from = new Date(now.getTime() - ({ "1h": 1, "8h": 8, "24h": 24, "7d": 168, "30d": 720 }[period]) * 3600_000);
    }
    const duration = to.getTime() - from.getTime();
    if (!Number.isFinite(duration) || duration <= 0 || duration > 400 * 86400_000) return null;
    return { from: from.toISOString(), to: to.toISOString(), group_by: duration <= 2 * 86400_000 ? "hour" : "day",
        tz_offset_minutes: String(-from.getTimezoneOffset()) };
}
