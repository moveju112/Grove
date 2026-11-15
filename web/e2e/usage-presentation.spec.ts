import { expect, test, type Page } from "@playwright/test";
import type { UsageReport, UsageRow } from "../app/components/usage/model";
import { login } from "./helpers";

const makeRow = (key: string, fields: Partial<UsageRow> = {}): UsageRow => ({
    key, label: key, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    reasoning_tokens: 0, reasoning_unreported_responses: 0, responses: 1,
    estimated_cost: [], unpriced_tokens: 0, ...fields,
});
const report: UsageReport = {
    rows: [
        makeRow("A", { input_tokens: 80, output_tokens: 20, cache_read_tokens: 40, reasoning_tokens: 5, responses: 2, estimated_cost: [{ currency: "USD", amount: 2 }, { currency: "EUR", amount: 1 }] }),
        makeRow("B", { input_tokens: 20, output_tokens: 30, responses: 2, reasoning_unreported_responses: 1, unpriced_tokens: 50, estimated_cost: [{ currency: "USD", amount: 0 }] }),
        makeRow("C", { reasoning_unreported_responses: 1 }),
    ],
    total: makeRow("total", { input_tokens: 100, output_tokens: 50, cache_read_tokens: 40, reasoning_tokens: 5, reasoning_unreported_responses: 2, responses: 5, unpriced_tokens: 50, estimated_cost: [{ currency: "USD", amount: 2 }, { currency: "EUR", amount: 1 }] }),
    pricing_versions: ["presentation-v1"],
};

async function openUsage(page: Page) {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("사용량");
    return page.getByTestId("usage-panel");
}

test("카드·도넛·통화별 정렬·키보드·기간과 묶음을 보존한다", async ({ page }) => {
    const queries: URL[] = [];
    await page.route("**/api/v1/usage?*", async (route) => {
        queries.push(new URL(route.request().url()));
        await route.fulfill({ json: report });
    });
    const panel = await openUsage(page);
    await expect(panel.getByTestId("usage-total")).toContainText("150");
    await expect(panel.getByTestId("usage-total")).toContainText("2 USD · 1 EUR");
    await expect(panel.getByTestId("usage-donut")).toContainText("입력 100 tokens · 66.7%");
    await expect(panel.getByTestId("usage-donut")).toContainText("출력 50 tokens · 33.3%");
    const table = panel.getByTestId("usage-table");
    await expect(table).toContainText("100 tokens · 66.7%");
    await expect(table).toContainText("가격 미설정 50 tokens");
    await expect(table).toContainText("미보고 응답 1개");
    await expect(table.locator("tbody th")).toHaveText(["A", "B", "C"]);
    await panel.getByLabel("정렬 기준").selectOption("cost:USD");
    await panel.getByLabel("정렬 방향").selectOption("asc");
    await expect(table.locator("tbody th")).toHaveText(["B", "A", "C"]);
    await panel.getByLabel("정렬 기준").selectOption("cost:EUR");
    await expect(table.locator("tbody th")).toHaveText(["A", "B", "C"]);
    const direction = panel.getByLabel("정렬 방향");
    await direction.focus();
    await direction.press("Home");
    await expect(direction).toHaveValue("desc");
    await direction.press("Tab");
    await expect(panel.getByRole("region", { name: "사용량 비교 표" })).toBeFocused();
    await panel.getByLabel("기간", { exact: true }).selectOption("30");
    await expect.poll(() => queries.at(-1)?.searchParams.get("group_by")).toBe("day");
    await expect.poll(() => {
        const query = queries.at(-1);
        return query ? (Date.parse(query.searchParams.get("to")!) - Date.parse(query.searchParams.get("from")!)) / 86_400_000 : 0;
    }).toBeGreaterThan(29);
    await panel.getByLabel("묶음", { exact: true }).selectOption("model");
    await expect.poll(() => queries.at(-1)?.searchParams.get("group_by")).toBe("model");
    await expect(table.locator("caption")).toContainText("모델별");
    await expect(panel).toContainText("presentation-v1");
});

test("로딩·실패·빈 결과·0 token 응답과 stale 실패를 구분하고 다시 조회한다", async ({ page }) => {
    let mode: "loading" | "error" | "empty" | "zero" = "loading";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const zero = makeRow("zero", { responses: 1, reasoning_unreported_responses: 1 });
    await page.route("**/api/v1/usage?*", async (route) => {
        if (mode === "loading") await gate;
        if (mode === "error") {
            await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "fixture unavailable", retryable: false } } });
        } else {
            await route.fulfill({ json: mode === "zero"
                ? { rows: [zero], total: zero, pricing_versions: [] }
                : { rows: [], total: makeRow("total", { responses: 0 }), pricing_versions: [] } });
        }
    });
    try {
        const panel = await openUsage(page);
        await expect(panel.getByRole("status").filter({ hasText: /\S/ })).toContainText("불러오는 중");
        await expect(panel.getByText("이 기간에 사용량이 없습니다.", { exact: true })).toHaveCount(0);
        mode = "error";
        release();
        await expect(panel.getByRole("alert")).toContainText("사용량 조회 실패");
        await expect(panel.getByTestId("usage-total")).toHaveCount(0);
        mode = "empty";
        await panel.getByRole("button", { name: "다시 시도", exact: true }).click();
        await expect(panel.getByText("이 기간에 사용량이 없습니다.", { exact: true })).toBeVisible();
        mode = "zero";
        await panel.getByRole("button", { name: "새로고침", exact: true }).click();
        await expect(panel.getByTestId("usage-table")).toBeVisible();
        await expect(panel.getByTestId("usage-donut")).toContainText("총 token이 0이라 비율을 계산하지 않습니다.");
        await expect(panel.getByText("이 기간에 사용량이 없습니다.", { exact: true })).toHaveCount(0);
        mode = "error";
        await panel.getByRole("button", { name: "새로고침", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("마지막 조회값 표시");
        await expect(panel.getByTestId("usage-table")).toBeVisible();
    } finally {
        release();
    }
});

test("실행 용량·대기 이유·취소 오류와 재시도를 유지한다", async ({ page }) => {
    let cancels = 0;
    await page.route("**/api/v1/usage?*", (route) => route.fulfill({ json: report }));
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
    const panel = await openUsage(page);
    const capacity = panel.getByTestId("usage-capacity");
    await expect(capacity).toContainText("서버 전체: 실행 1/1");
    await expect(capacity).toContainText("공급자 한도 1/1 · 앞에 2개");
    await capacity.getByRole("button", { name: "취소", exact: true }).click();
    await expect(capacity.getByRole("alert")).toHaveText("취소 시험 오류");
    await capacity.getByRole("button", { name: "취소", exact: true }).click();
    await expect(capacity).toContainText("이 기기에서 실행·대기 중인 요청이 없습니다.");
    expect(cancels).toBe(2);
});
