import { expect, type Page, type TestInfo } from "@playwright/test";
import type { UsageDashboard, UsageMetrics, UsageSlice } from "../app/api/generated";
import { login, openUsage, selectChoice } from "./helpers";

export const metrics = (patch: Partial<UsageMetrics> = {}): UsageMetrics => ({
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    reasoning_tokens: 0, cache_write_unreported_responses: 0, reasoning_unreported_responses: 0,
    responses: 0, unreported_responses: 0, measured_responses: 0, measured_output_tokens: 0,
    response_ms: 0, cli_measured_responses: 0, tok_per_second: null, low10_tok_per_second: null, high10_tok_per_second: null, ...patch,
});
const codex = metrics({ input_tokens: 800, output_tokens: 200, cache_read_tokens: 400, responses: 3,
    low10_tok_per_second: 10, high10_tok_per_second: 30, measured_responses: 2, measured_output_tokens: 200, response_ms: 10000, cli_measured_responses: 2, tok_per_second: 20 });
const claude = metrics({ input_tokens: 200, output_tokens: 300, cache_read_tokens: 100, responses: 2,
    low10_tok_per_second: 100, high10_tok_per_second: 100, measured_responses: 1, measured_output_tokens: 300, response_ms: 3000, cli_measured_responses: 1, tok_per_second: 100 });
const slice = (key: string, provider: string, value: UsageMetrics): UsageSlice => ({ key, label: key, provider, metrics: value });
export const report: UsageDashboard = {
    from: "2026-11-17T00:00:00Z", to: "2026-11-17T03:00:00Z", interval: "hour",
    total: metrics({ input_tokens: 1000, output_tokens: 500, cache_read_tokens: 500, responses: 5,
        low10_tok_per_second: 10, high10_tok_per_second: 100, measured_responses: 3, measured_output_tokens: 500, response_ms: 13000, cli_measured_responses: 3, tok_per_second: 500 / 13 }),
    providers: [slice("codex_cli", "codex_cli", codex), slice("claude_code", "claude_code", claude)],
    models: [slice("gpt-6.1", "codex_cli", codex), slice("claude-sonnet", "claude_code", claude)],
    projects: [slice("같은 프로젝트", "codex_cli", codex), slice("같은 프로젝트", "claude_code", claude)],
    agents: [], workflows: [], sessions: [], efforts: [{ ...slice("effort1", "codex_cli", codex), context: { agent: "개발", model: "gpt-6.1", effort: "high", fast: true } }, { ...slice("effort2", "claude_code", claude), context: { agent: "개발", model: "claude-sonnet", effort: null, fast: null } }],
    series: [
        { start: "2026-11-17T00:00:00Z", total: codex, providers: [slice("codex_cli", "codex_cli", codex)] },
        { start: "2026-11-17T01:00:00Z", total: metrics(), providers: [] },
        { start: "2026-11-17T02:00:00Z", total: claude, providers: [slice("claude_code", "claude_code", claude)] },
    ],
    estimated_cost: [{ currency: "USD", amount: 2 }, { currency: "EUR", amount: 1 }], unpriced_tokens: 50, pricing_versions: ["presentation-v2"],
};

export async function checkDashboard(page: Page, info: TestInfo) {
    const queries: URL[] = [];
    await page.route("**/api/v1/usage/dashboard?*", async (route) => {
        queries.push(new URL(route.request().url()));
        await route.fulfill({ json: report });
    });
    await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: { accounts: [
        { protocol: "codex_cli", name: "Codex", status: "available", checked_at: "2026-11-17T00:00:00Z", limits: [{ label: "5시간", remaining_percent: 75, remaining: null, resets_at: "2099-11-17T00:00:00Z" }] },
        { protocol: "claude_code", name: "Claude", status: "unsupported", checked_at: "2026-11-17T00:00:00Z", limits: [] },
    ] } }));
    await login(page);
    const panel = await openUsage(page);
    await expect(panel.getByRole("heading", { name: "사용량", exact: true })).toBeFocused();
    await expect(panel.locator('[data-testid="usage-token-codex_cli"]:visible')).toHaveAttribute("aria-label", "1,000 토큰");
    await expect(panel.locator('[data-testid="usage-speed-codex_cli"]:visible')).toHaveText("20.0 tok/s");
    await expect(panel.getByText(/평균 모델 속도:.*측정 3\/5개 응답/)).toBeVisible();
    await expect(panel.getByTestId("usage-providers")).toContainText("Codex");
    await expect(panel.getByTestId("usage-providers")).toContainText("Claude");
    await expect(panel.getByRole("tab")).toHaveCount(0);
    const mobile = page.viewportSize()!.width <= 760;
    await page.screenshot({ path: info.outputPath(mobile ? "usage-mobile.png" : "usage-desktop.png") });
    const charts = panel.getByTestId("usage-charts");
    const tokenChart = panel.getByTestId("usage-chart-tokens");
    const svg = tokenChart.getByRole("group", { name: "시간별 토큰 사용량" });
    expect((await svg.boundingBox())!.height).toBe(140);
    const summary = panel.getByRole("table", { name: mobile ? "Codex CLI 사용량 요약" : "제공자별 사용량 요약", exact: true });
    const columns = await summary.getByRole("columnheader").evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
    expect(columns[mobile ? 1 : 4]).toBeGreaterThanOrEqual(112);
    const cardStyle = await panel.getByTestId("usage-providers").evaluate((node) => {
        const style = getComputedStyle(node);
        return { padding: style.paddingTop, radius: style.borderTopLeftRadius, border: style.borderTopWidth };
    });
    expect(cardStyle).toEqual({ padding: "14px", radius: "12px", border: "1px" });
    await expect(summary).toContainText("10.0 tok/s");
    await expect(summary).toContainText("30.0 tok/s");
    const claudeSummary = mobile ? panel.getByRole("table", { name: "Claude 사용량 요약", exact: true }) : summary;
    await expect(claudeSummary).toContainText("100.0 tok/s");
    expect(await summary.getByRole("columnheader").first().evaluate((node) => getComputedStyle(node).fontSize)).toBe("11px");
    await tokenChart.getByRole("button").first().click();
    await expect(tokenChart.locator("output")).toContainText("1,000 토큰 · 20.0 tok/s");
    await tokenChart.getByRole("button").first().press("ArrowRight");
    await expect(tokenChart.locator("output")).toContainText("0 토큰 · — tok/s");
    await expect(tokenChart.getByRole("button").nth(1)).toBeFocused();
    const listing = panel.getByTestId("usage-table");
    await expect(listing).toBeVisible();
    await expect(panel.getByRole("table", { name: "개발 에이전트 사용량" })).toContainText("켜짐");
    const quotas = panel.getByRole("region", { name: "OAuth 한도", exact: true });
    await expect(quotas.getByRole("img", { name: "Codex CLI 5시간 사용 25.0%", exact: true })).toBeVisible();
    await expect(quotas).toContainText("한도 조회 미지원");
    await selectChoice(panel.getByLabel("정렬 기준", { exact: true }), "speed");
    await expect(listing.getByRole("button").first()).toHaveText("Claude · claude-sonnet");
    await selectChoice(panel.getByLabel("공급자 필터", { exact: true }), "codex_cli");
    await expect(listing.getByRole("button")).toHaveCount(1);
    await listing.getByRole("button").first().click();
    await expect(listing).toContainText("새 입력 400 · 출력 200");
    await expect(listing.getByRole("columnheader", { name: "캐시 읽기", exact: true })).toBeVisible();
    await expect(listing.getByRole("columnheader", { name: "캐시 쓰기", exact: true })).toBeVisible();
    await expect(panel.locator('[data-testid="usage-speed-codex_cli"]:visible')).toHaveText("20.0 tok/s");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await listing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(mobile ? "usage-details-mobile.png" : "usage-details-desktop.png") });
    await panel.getByRole("group", { name: "기간", exact: true }).getByRole("button", { name: "지난 7일", exact: true }).click();
    await expect.poll(() => queries.at(-1)?.searchParams.get("group_by")).toBe("day");
    await panel.getByRole("group", { name: "기간", exact: true }).getByRole("button", { name: "사용자 지정", exact: true }).click();
    await panel.getByLabel("시작일", { exact: true }).fill("2026-11-17");
    await panel.getByLabel("종료일", { exact: true }).fill("2026-11-17");
    await expect.poll(() => queries.at(-1)?.searchParams.get("group_by")).toBe("hour");
    expect(Date.parse(queries.at(-1)!.searchParams.get("to")!) - Date.parse(queries.at(-1)!.searchParams.get("from")!)).toBe(86400_000);
    const dialog = page.getByRole("dialog", { name: "사용량", exact: true });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThan(0);
    expect(bounds.y).toBeGreaterThan(0);
    expect(bounds.x + bounds.width).toBeLessThan(page.viewportSize()!.width);
    expect(bounds.y + bounds.height).toBeLessThan(page.viewportSize()!.height);
    // 모달의 양 끝에서 Tab과 Shift+Tab으로 배경 화면에 빠져나가지 않는다.
    const controls = dialog.locator('button:not(:disabled), input:not(:disabled), [tabindex="0"]').filter({ visible: true });
    await controls.last().focus();
    await page.keyboard.press("Tab");
    await expect(controls.first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(controls.last()).toBeFocused();
    await panel.getByRole("button", { name: "사용량 닫기", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: mobile ? "사이드바" : "사용량", exact: true })).toBeFocused();
    await expect(page).not.toHaveURL(/#usage$/);
    await openUsage(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("시작일", { exact: true })).toHaveValue("2026-11-17");
    await page.reload();
    await expect(page.getByRole("dialog", { name: "사용량", exact: true })).toHaveCount(0);
    await openUsage(page);
    await expect(page.locator('[data-testid="usage-speed-codex_cli"]:visible')).toHaveText("20.0 tok/s");
    await expect(charts).toBeVisible();
    // 입력에 초점이 있어도 Escape로 닫고, 모션 줄이기에서도 빠른 재열기와 닫기를 유지한다.
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
        await page.emulateMedia({ reducedMotion });
        await panel.getByRole("group", { name: "기간", exact: true }).getByRole("button", { name: "사용자 지정", exact: true }).click();
        await panel.getByLabel("시작일", { exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await openUsage(page);
        await panel.getByRole("button", { name: "사용량 닫기", exact: true }).click();
        await expect(dialog).toBeHidden();
        await openUsage(page);
        await page.mouse.click(2, 2);
        await expect(dialog).toBeHidden();
        await openUsage(page);
    }
}
