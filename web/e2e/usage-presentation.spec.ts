import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openUsage, sessionView } from "./helpers";
import { checkDashboard, metrics, report } from "./usage-dashboard-checks";

test("PC 사용량은 공급자별 토큰·속도·그래프·정렬·기간을 제공한다", async ({ page }, info) => {
    await checkDashboard(page, info);
});

test("320~1920px에서 긴 모델명·큰 토큰 수를 표시하고 대화 입력을 보존한다", async ({ page }, info) => {
    const large = { ...report, total: { ...report.total, input_tokens: 9_000_000_000_000, output_tokens: 1_000_000_000_000 },
        providers: report.providers.map((row) => ({ ...row, metrics: { ...row.metrics, input_tokens: 9_000_000_000_000, output_tokens: 1_000_000_000_000 } })),
        models: report.models.map((row) => ({ ...row, label: `${row.label}-${"long-model-name".repeat(12)}` })) };
    await page.route("**/api/v1/usage/dashboard?*", (route) => route.fulfill({ json: large }));
    const { a } = await ensureProjects();
    const title = `사용량 복귀 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    await view.getByLabel("메시지 입력", { exact: true }).fill("사용량 확인 후에도 보존할 입력");
    const originalURL = page.url();
    const originalTabs = await page.getByRole("tab").count();
    const composerBounds = await view.getByTestId("composer").boundingBox();
    let panel = await openUsage(page);
    expect(page.url()).toBe(originalURL);
    expect(await view.getByTestId("composer").boundingBox()).toEqual(composerBounds);
    await expect(page.getByRole("tab")).toHaveCount(originalTabs);
    await panel.getByRole("button", { name: "사용량 새로고침", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "사용량", exact: true })).toBeFocused();
    panel = await openUsage(page);
    await expect(view).toBeVisible();
    await expect(view.getByLabel("메시지 입력", { exact: true })).toHaveValue("사용량 확인 후에도 보존할 입력");
    await panel.getByRole("button", { name: "사용량 닫기", exact: true }).click();
    await expect(view.getByLabel("메시지 입력", { exact: true })).toHaveValue("사용량 확인 후에도 보존할 입력");
    panel = await openUsage(page);
    for (const width of [320, 390, 760, 768, 1024, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(panel).toBeVisible();
        const list = panel.getByTestId("usage-table");
        await expect(list).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const token = panel.locator('[data-testid="usage-token-codex_cli"]:visible');
        expect(await token.evaluate((node) => {
            const cell = node.closest("td")!;
            return cell.scrollWidth <= cell.clientWidth + 1;
        })).toBe(true);
        const card = panel.getByTestId("usage-providers");
        expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        if (width <= 760) {
            const dialog = page.getByRole("dialog", { name: "사용량", exact: true });
            await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(width - 10);
            const summary = card.getByRole("table", { name: "Codex CLI 사용량 요약", exact: true });
            const cardBounds = (await card.boundingBox())!;
            const summaryBounds = (await summary.boundingBox())!;
            expect(cardBounds.x).toBeLessThanOrEqual(16);
            expect(width - (cardBounds.x + cardBounds.width)).toBeLessThanOrEqual(16);
            expect(summaryBounds.x).toBeGreaterThanOrEqual(cardBounds.x);
            expect(summaryBounds.x + summaryBounds.width).toBeLessThanOrEqual(cardBounds.x + cardBounds.width + 1);
        }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await panel.getByRole("heading", { name: "사용량", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("usage-dark-mobile.png") });
});

test("조회 실패·빈 기록·미측정 속도·갱신 실패를 구분하고 다시 조회한다", async ({ page }) => {
    let mode: "error" | "empty" | "zero" = "error";
    await page.route("**/api/v1/usage/dashboard?*", async (route) => {
        if (mode === "error") await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "fixture unavailable", retryable: false } } });
        else await route.fulfill({ json: { ...report, total: metrics({ responses: mode === "zero" ? 1 : 0 }),
            providers: mode === "zero" ? report.providers.map((row) => ({ ...row, metrics: metrics({ responses: 1 }) })) : report.providers } });
    });
    await login(page);
    const panel = await openUsage(page);
    await expect(panel.getByRole("alert")).toContainText("사용량을 불러오지 못했어요.");
    await expect(panel.getByTestId("usage-total")).toHaveCount(0);
    mode = "empty";
    await panel.getByRole("button", { name: "사용량 새로고침", exact: true }).click();
    await expect(panel.getByText("이 기간에 기록된 사용량이 없어요.", { exact: true })).toBeVisible();
    mode = "zero";
    await panel.getByRole("button", { name: "사용량 새로고침", exact: true }).click();
    await expect(panel.locator('[data-testid="usage-speed-codex_cli"]:visible')).toHaveText("미측정");
    await expect(panel.getByTestId("usage-table")).toBeVisible();
    mode = "error";
    await panel.getByRole("button", { name: "사용량 새로고침", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("마지막 조회값을 표시해요.");
    await expect(panel.getByTestId("usage-table")).toBeVisible();
});

test("실행 용량·대기 이유·취소 오류와 재시도를 유지한다", async ({ page }) => {
    let cancels = 0;
    await page.route("**/api/v1/usage/dashboard?*", (route) => route.fulfill({ json: report }));
    await page.route("**/api/v1/usage/capacity", (route) => route.fulfill({ json: {
        limits: { max_active: 1, max_queued_per_owner: 2, max_queued_total: 3 },
        server: { running: 1, waiting: cancels < 2 ? 1 : 0 },
        mine: { running: 0, waiting: cancels < 2 ? 1 : 0, awaiting_user: 0 },
        requests: cancels < 2 ? [{ turn_id: "usage-presentation-owned", status: "queued", session_id: "fixture", session_title: "대기 시험", project_id: "fixture", queue: { ahead: 2, active: 1, limit: 1, reason: "provider" } }] : [],
    } }));
    await page.route("**/api/v1/turns/usage-presentation-owned/cancel", (route) => {
        cancels++;
        return cancels === 1
            ? route.fulfill({ status: 409, json: { error: { code: "fixture_cancel", message: "취소 시험 오류", retryable: false } } })
            : route.fulfill({ json: {} });
    });
    await login(page);
    const panel = await openUsage(page);
    await panel.getByRole("button", { name: "실행 현황·추정 비용", exact: true }).click();
    const capacity = panel.getByTestId("usage-capacity");
    await expect(capacity).toContainText("서버 전체: 실행 1/1");
    await expect(capacity).toContainText("공급자 한도 1/1 · 앞에 2개");
    await capacity.getByRole("button", { name: "취소", exact: true }).click();
    await expect(capacity.getByRole("alert")).toHaveText("취소 시험 오류");
    await capacity.getByRole("button", { name: "취소", exact: true }).click();
    await expect(capacity).toContainText("이 기기에서 실행·대기 중인 요청이 없습니다.");
    expect(cancels).toBe(2);
});

test("OAuth 한도 조회 전에도 카드 자리를 잡아 도착 시 아래 통계가 밀리지 않는다", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const limits = [
        { label: "5시간", remaining_percent: 70, remaining: null, resets_at: "2099-11-17T00:00:00Z" },
        { label: "주간", remaining_percent: 40, remaining: null, resets_at: "2099-11-20T00:00:00Z" },
    ];
    await page.route("**/api/v1/usage/dashboard?*", (route) => route.fulfill({ json: report }));
    await page.route("**/api/v1/usage/accounts", async (route) => {
        await held;
        await route.fulfill({ json: { accounts: [
            { protocol: "claude_code", name: "Claude", status: "available", checked_at: "2026-11-17T00:00:00Z", limits },
            { protocol: "codex_cli", name: "Codex", status: "available", checked_at: "2026-11-17T00:00:00Z", limits },
        ] } });
    });
    await login(page);
    const panel = await openUsage(page);
    const quotas = panel.getByRole("region", { name: "OAuth 한도", exact: true });
    await expect(quotas).toContainText("조회 중");
    const charts = panel.getByTestId("usage-charts");
    const before = (await charts.boundingBox())!.y;
    release();
    await expect(quotas.getByRole("img", { name: "Codex CLI 주간 사용 60.0%", exact: true })).toBeVisible();
    expect(Math.abs((await charts.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
});
