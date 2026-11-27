import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountUsageLimit, AccountUsageReport } from "../app/api/generated";
import { apiCall, login, openSettings, openUsage, profileAction, selectChoice, state } from "./helpers";

const limit = (label: string, remaining_percent: number): AccountUsageLimit =>
    ({ label, remaining_percent, remaining: null, resets_at: "2100-01-01T00:00:00Z" });
const report: AccountUsageReport = { accounts: [
    { protocol: "codex_cli", name: "Codex", status: "available", checked_at: "2026-01-01T00:00:00Z", limits: [limit("5시간", 82), limit("주간", 39)] },
    { protocol: "claude_code", name: "Claude", status: "unsupported", checked_at: "2026-01-01T00:00:00Z", limits: [] },
] };

test.beforeEach(async () => {
    if (process.env.GROVE_E2E_FAKE_CLI === "1") await writeFile(join(state().cliDir!, "claude-auth"), "out");
});
test.afterEach(async () => {
    if (process.env.GROVE_E2E_FAKE_CLI === "1") await writeFile(join(state().cliDir!, "claude-auth"), "in");
});

for (const width of [390, 1280]) for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme} 잔여 사용량`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("최근 목록 아래에 사용률을 두 줄로 표시하고 모달에서는 상세 한도와 조회 상태를 표시한다", async ({ page }, info) => {
            let queries = 0;
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.route("**/api/v1/usage/accounts", (route) => {
                queries++;
                return route.fulfill({ json: report });
            });
            await login(page);
            const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
            // 닫힌 모바일 서랍은 한도를 조회하지 않는다.
            if (width < 760) {
                await expect(sidebar).toHaveAttribute("aria-expanded", "false");
                expect(queries).toBe(0);
                await sidebar.click();
            }
            const side = page.getByRole("complementary", { name: "탐색" });
            const summary = side.getByRole("region", { name: "사용 한도", exact: true });
            await expect(summary.getByLabel("Codex 5시간 사용 18%", { exact: false })).toBeVisible();
            await expect(summary.getByLabel("Codex 주간 사용 61%", { exact: false })).toBeVisible();
            await expect(summary.getByRole("progressbar")).toHaveCount(2);
            await expect(summary.getByText("한도 조회 미지원", { exact: true })).toBeVisible();
            const [recent, usage, navigation] = await Promise.all([side.getByTestId("recent-scroll"), summary, side].map((node) => node.boundingBox()));
            expect(usage!.y).toBeGreaterThanOrEqual(recent!.y + recent!.height);
            expect(usage!.y + usage!.height).toBeLessThanOrEqual(navigation!.y + navigation!.height);
            expect(usage!.height).toBeLessThanOrEqual(88);
            expect(await summary.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath("sidebar-usage.png") });
            const panel = await openUsage(page);
            const quotas = panel.getByRole("region", { name: "OAuth 한도", exact: true });
            await expect(quotas.getByRole("img", { name: "Codex CLI 5시간 사용 18.0%", exact: true })).toBeVisible();
            await expect(quotas.getByRole("img", { name: "Codex CLI 주간 사용 61.0%", exact: true })).toBeVisible();
            await expect(quotas.getByText("한도 조회 미지원", { exact: true })).toBeVisible();
            await expect(quotas.getByRole("link", { name: "Claude에서 확인" })).toHaveAttribute("href", "https://claude.ai/settings/usage");
            await expect(quotas.getByRole("img", { name: /^Claude/ })).toHaveCount(0);
            expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
            await quotas.scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath("usage-quota-modal.png") });
            await page.keyboard.press("Escape");
            await expect(panel).toBeHidden();
        });

        test("인증 필요를 누르면 해당 계정 설정만 열고 로그인은 자동 시작하지 않는다", async ({ page }, info) => {
            const current = structuredClone(report);
            for (const account of current.accounts) { account.status = "authentication_required"; account.limits = []; }
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: current }));
            const mutations: string[] = [];
            page.on("request", (request) => {
                if (request.method() === "POST" && /\/agent-backends\/[^/]+\/(?:login|logout)(?:\/|$)/.test(request.url())) mutations.push(request.url());
            });
            await login(page);
            // 사이드바의 인증 필요도 같은 계정 설정을 연다.
            const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await page.getByRole("complementary", { name: "탐색" }).getByRole("button", { name: "Claude 인증 설정 열기", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "Claude Code 로그인", exact: true })).toBeVisible();
            if (width < 760) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
            await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog", { name: "Claude Code 로그인", exact: true })).toHaveCount(0);
            expect(mutations).toEqual([]);
            const usagePanel = await openUsage(page);
            const claude = usagePanel.getByRole("button", { name: "Claude 인증 설정 열기", exact: true });
            const button = (await claude.boundingBox())!;
            expect(button.height).toBeGreaterThanOrEqual(32);
            await claude.click();
            const dialog = page.getByRole("dialog", { name: "Claude Code 로그인", exact: true });
            await expect(dialog).toBeVisible();
            if (width < 760) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
            const account = dialog.getByRole("region", { name: "Claude Code 계정", exact: true });
            await expect(account.getByText("claude auth login", { exact: true })).toBeVisible();
            await expect(account.getByRole("button", { name: "로그인", exact: true })).toHaveCount(0);
            await expect(dialog.getByRole("region", { name: "Codex 계정", exact: true })).toHaveCount(0);
            expect(mutations).toEqual([]);
            expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath("claude-auth-settings.png") });
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            const codex = (await openUsage(page)).getByRole("button", { name: "Codex CLI 인증 설정 열기", exact: true });
            await codex.focus();
            await codex.press("Enter");
            const codexDialog = page.getByRole("dialog", { name: "Codex 로그인", exact: true });
            await expect(codexDialog.getByRole("region", { name: "Codex 계정", exact: true })).toBeVisible();
            await expect(codexDialog.getByRole("region", { name: "Claude Code 계정", exact: true })).toHaveCount(0);
            expect(mutations).toEqual([]);
            await codexDialog.getByRole("button", { name: "로그인 창 닫기", exact: true }).click();
            await openSettings(page);
            await expect(page.getByRole("tab", { name: "데몬 설정", exact: true })).toBeVisible();
        });
    });
}

test("사이드바는 요금제에 없는 5시간 자리를 비우고 높은 사용률에도 같은 색 막대를 쓴다", async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: { accounts: [
        { ...report.accounts[0], limits: [limit("주간", 5)] },
        { ...report.accounts[1], status: "available", limits: [limit("5시간", 36), limit("주간", 68)] },
    ] } }));
    await login(page);
    const summary = page.getByRole("complementary", { name: "탐색" }).getByRole("region", { name: "사용 한도", exact: true });
    await expect(summary.getByLabel("Codex 주간 사용 95%", { exact: false })).toBeVisible();
    await expect(summary.getByText("Codex 5시간", { exact: true })).toHaveCount(0);
    await expect(summary.getByText("—", { exact: true })).toHaveCount(0);
    const x = async (text: string) => (await summary.getByText(text, { exact: true }).boundingBox())!.x;
    expect(await x("Codex 주간")).toBe(await x("Claude 주간"));
    const fills = await summary.locator(".astryx-progress-bar-fill").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
    expect(fills).toHaveLength(3);
    expect(new Set(fills).size).toBe(1);
    await summary.screenshot({ path: info.outputPath("sidebar-usage-missing-period.png") });
});

for (const width of [390, 1280]) test(`${width}px 사이드바는 초기화까지 남은 시간과 경과 눈금을 92px 안에 표시한다`, async ({ page }, info) => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const hour = 3_600_000;
    const reset = (label: string, used: number, ms: number): AccountUsageLimit => ({ ...limit(label, 100 - used), resets_at: at(ms) });
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: { accounts: [
        { ...report.accounts[0], limits: [reset("5시간", 33, 3 * hour - 60_000), reset("주간", 35, 4 * 24 * hour + 16.5 * hour)] },
        { ...report.accounts[1], status: "available", limits: [reset("5시간", 9, 2 * hour + 15 * 60_000), reset("주간", 16, 5 * 24 * hour + 7.5 * hour)] },
    ] } }));
    await login(page);
    if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    const summary = page.getByRole("complementary", { name: "탐색" }).getByRole("region", { name: "사용 한도", exact: true });
    await expect(summary.getByText(/^2시간 1[45]분 남음$/)).toBeVisible();
    await expect(summary.getByText(/^5일 7시간 남음$/)).toBeVisible();
    await expect(summary.getByText(/남음$/)).toHaveCount(4);
    const tracks = await summary.locator(".astryx-progress-bar-track").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(tracks).toEqual([6, 6, 6, 6]);
    const fontSize = (text: RegExp) => summary.getByText(text).first().evaluate((node) => getComputedStyle(node).fontSize);
    expect(await fontSize(/^5일 7시간 남음$/)).toBe("10.5px");
    expect(await fontSize(/^5일 7시간 남음$/)).toBe(await fontSize(/^16%$/));
    expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(92);
    expect(await summary.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await summary.screenshot({ path: info.outputPath("sidebar-usage-reset.png") });
});

test("설정에서 탐색 영역 사용량을 숨기면 요약과 조회를 멈추고 새로고침 뒤에도 유지한다", async ({ page }, info) => {
    let queries = 0;
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.route("**/api/v1/usage/accounts", (route) => { queries++; return route.fulfill({ json: report }); });
    await login(page);
    const summary = page.getByRole("complementary", { name: "탐색" }).getByRole("region", { name: "사용 한도", exact: true });
    await expect(summary).toBeVisible();
    await openSettings(page, "local");
    await page.getByLabel("설정 검색").fill("사용량");
    const setting = page.getByTestId("setting-sidebar-usage").getByRole("combobox", { name: "사용량 표시", exact: true });
    await selectChoice(setting, "false");
    await expect(summary).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("sidebar-usage-hidden.png") });
    await page.reload();
    await expect(page.getByRole("complementary", { name: "탐색" })).toBeVisible();
    queries = 0;
    await page.waitForTimeout(500);
    await expect(summary).toHaveCount(0);
    expect(queries).toBe(0);
    await openSettings(page, "local");
    await page.getByLabel("설정 검색").fill("사용량");
    await selectChoice(setting, "true");
    await expect(summary).toBeVisible();
});

test("통계 조회가 실패해도 Codex 주간 한도와 크레딧을 표시하고 다시 열면 오래된 값을 갱신한다", async ({ page }) => {
    let remaining = 82;
    const now = Date.now();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(now);
    await page.route("**/api/v1/usage/dashboard?*", (route) => route.fulfill({
        status: 500, json: { error: { code: "fixture_error", message: "통계 조회 실패", retryable: false } },
    }));
    await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: { accounts: [
        { ...report.accounts[0], limits: [limit("주간", remaining),
            { label: "크레딧", remaining_percent: null, remaining: "12.5", resets_at: null }] },
    ] } }));
    await login(page);
    const panel = await openUsage(page);
    await expect(panel.getByRole("alert")).toContainText("사용량을 불러오지 못했어요");
    await expect(panel.getByText("18% 사용 · 82% 남음", { exact: true })).toBeVisible();
    await expect(panel.getByText("12.5", { exact: true })).toBeVisible();
    await expect(panel.getByRole("img", { name: /Codex CLI 5시간/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    remaining = 63;
    await page.clock.setFixedTime(now + 61_000);
    await openUsage(page);
    await expect(panel.getByText("37% 사용 · 63% 남음", { exact: true })).toBeVisible();
});

test("실제 계정 API는 CLI 읽기 응답만 반환하고 같은 공급자의 여러 프로필을 합친다", async ({ page }) => {
    test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI fixture 필요");
    for (const name of ["quota-a", "quota-b"]) {
        await apiCall("POST", "/model-profiles", { name, protocol: "codex_cli", base_url: "", model: "default" });
    }
    await login(page);
    const response = await apiCall<AccountUsageReport>("GET", "/usage/accounts");
    const codex = response.accounts.filter((account) => account.protocol === "codex_cli");
    expect(codex).toHaveLength(1);
    expect(codex[0]!.status).toBe("available");
    expect(codex[0]!.limits.map((item) => [item.label, item.remaining_percent])).toEqual([["5시간", 82], ["주간", 39]]);
    expect(JSON.stringify(response)).not.toContain("private-fixture-account");
});

test("Claude는 서버 CLI 인증의 두 구독 한도를 표시하고 캐시한다", async ({ page }, info) => {
    test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI 인증 fixture 필요");
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "Claude policy-safe", protocol: "claude_code", base_url: "", model: "default",
    });
    const auth = join(state().cliDir!, "claude-auth");
    const quota = async () => {
        const report = await apiCall<AccountUsageReport>("GET", "/usage/accounts");
        const claude = report.accounts.find((account) => account.protocol === "claude_code")!;
        expect(JSON.stringify(report)).not.toContain("must-not-be-returned");
        expect(JSON.stringify(report)).not.toContain("private-fixture-usage-output");
        return claude;
    };
    try {
        await page.setViewportSize({ width: 390, height: 844 });
        // 사이드바 요약이 로그아웃 상태를 먼저 조회하면 서버가 '인증 필요'를 60초 동안 캐시한다.
        // 이 시험은 캐시가 비어 있는 상태에서 로그인 뒤 첫 조회를 확인하므로 그동안 화면 조회를 서버로 보내지 않는다.
        await page.route("**/api/v1/usage/accounts", (route) => route.fulfill({ json: { accounts: [] } }));
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: "Claude policy-safe" });
        await profileAction(row, "연결 확인");
        await expect(row.getByTestId("profile-check")).toContainText("설치됨");
        await expect(row.getByTestId("profile-check")).not.toContainText("연결됨");
        await page.screenshot({ path: info.outputPath("claude-installed-mobile.png") });
        await writeFile(auth, "in");
        await expect.poll(quota).toMatchObject({ status: "available", limits: [
            limit("5시간", 87.5), { ...limit("주간", 30), resets_at: "2100-01-02T00:00:00Z" },
        ] });
        await page.keyboard.press("Escape");
        await page.unroute("**/api/v1/usage/accounts");
        const panel = await openUsage(page);
        await expect(panel.getByRole("img", { name: "Claude 5시간 사용 12.5%", exact: true })).toBeVisible();
        await expect(panel.getByRole("img", { name: "Claude 주간 사용 70.0%", exact: true })).toBeVisible();
        await expect(panel.getByRole("link", { name: "Claude에서 확인" })).toHaveCount(0);
        await panel.getByRole("button", { name: "사용량 새로고침" }).click();
        const cached = await Promise.all([quota(), quota()]);
        expect(cached[0]).toEqual(cached[1]);
        expect(await readFile(join(state().cliDir!, "claude-usage-requests"), "utf8")).toBe("usage\n");
        await page.screenshot({ path: info.outputPath("claude-usage-mobile.png") });
    } finally {
        await writeFile(auth, "out");
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});
