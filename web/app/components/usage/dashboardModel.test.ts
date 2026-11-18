import { describe, expect, it } from "vitest";
import type { UsageDashboard, UsageMetrics, UsageSlice } from "../../api/generated";
import { compact, providerRows, sortedRows, speed, tokens, usageRange } from "./dashboardModel";

const metrics = (patch: Partial<UsageMetrics> = {}): UsageMetrics => ({
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    reasoning_tokens: 0, cache_write_unreported_responses: 0, reasoning_unreported_responses: 0,
    responses: 1, unreported_responses: 0, measured_responses: 0, measured_output_tokens: 0,
    response_ms: 0, cli_measured_responses: 0, tok_per_second: null, low10_tok_per_second: null, high10_tok_per_second: null, ...patch,
});
const row = (key: string, provider: string, patch: Partial<UsageMetrics>): UsageSlice => ({ key, label: key, provider, metrics: metrics(patch) });

describe("통합 사용량 표시", () => {
    it("캐시·reasoning을 총 토큰에 중복 가산하지 않는다", () => {
        expect(tokens(metrics({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 80, reasoning_tokens: 10 }))).toBe(120);
        expect(speed(null)).toBe("—");
        expect(speed(20)).toBe("20.0");
        expect(compact(1000)).toBe("1.0K");
        expect(speed(0.02)).toBe("0.0");
    });
    it("공급자 필터와 속도 정렬은 요약 원본을 바꾸지 않고 미측정을 뒤에 둔다", () => {
        const models = [row("legacy", "codex_cli", { input_tokens: 1000 }), row("slow", "codex_cli", { tok_per_second: 20 }), row("fast", "claude_code", { tok_per_second: 100 })];
        const report = { models } as UsageDashboard;
        expect(sortedRows(report, "models", "speed", "all").map((r) => r.key)).toEqual(["fast", "slow", "legacy"]);
        expect(sortedRows(report, "models", "tokens", "codex_cli").map((r) => r.key)).toEqual(["legacy", "slow"]);
        expect(models.map((r) => r.key)).toEqual(["legacy", "slow", "fast"]);
        expect(providerRows([models[2]!, models[0]!]).map((r) => r.provider)).toEqual(["codex_cli", "claude_code"]);
    });
});

describe("사용량 기간", () => {
    it("1·8·24시간은 시간별, 7일·30일은 일별이며 종료는 현재 시각이다", () => {
        const now = new Date("2026-11-17T12:34:56Z");
        for (const period of ["1h", "8h", "24h", "7d", "30d"] as const) {
            const range = usageRange(period, "", "", now)!;
            expect(range.to).toBe(now.toISOString());
            expect(Date.parse(range.to) - Date.parse(range.from)).toBe(({ "1h": 1, "8h": 8, "24h": 24, "7d": 168, "30d": 720 }[period]) * 3600_000);
            expect(range.group_by).toBe(["1h", "8h", "24h"].includes(period) ? "hour" : "day");
        }
    });
    it("직접 지정한 마지막 날짜 전체를 포함하고 역전·잘못된 날짜·400일 초과를 거부한다", () => {
        const day = usageRange("custom", "2026-11-17", "2026-11-17")!;
        expect(new Date(day.from).getDate()).toBe(17);
        expect(new Date(day.to).getDate()).toBe(18);
        expect(day.group_by).toBe("hour");
        for (const [from, to] of [["", "2026-11-17"], ["2026-11-18", "2026-11-17"], ["2026-02-31", "2026-03-01"], ["2025-01-01", "2026-11-17"]] as const) {
            expect(usageRange("custom", from, to)).toBeNull();
        }
    });
});
