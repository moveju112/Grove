import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { login } from "./helpers";

test("진단 묶음은 범위 확인 뒤에만 만들고 미리 보기·다운로드·지우기를 제공한다", async ({ page }) => {
    let generated = 0;
    page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/v1/admin/diagnostics") generated++;
    });
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("진단");
    const panel = page.getByTestId("diagnostics-bundle");
    await expect(panel).toContainText("소유자 전용");
    expect(generated).toBe(0);
    await panel.getByRole("button", { name: "진단 묶음 준비", exact: true }).click();
    await expect(panel.getByRole("button", { name: "진단 묶음 생성", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "취소", exact: true }).click();
    expect(generated).toBe(0);
    await panel.getByRole("button", { name: "진단 묶음 준비", exact: true }).click();
    await panel.getByLabel("정보 범위를 확인했습니다").check();
    await panel.getByRole("button", { name: "진단 묶음 생성", exact: true }).click();
    await panel.getByText("공유 전 진단 묶음 미리 보기", { exact: true }).click();
    const preview = await panel.getByTestId("diagnostics-preview").innerText();
    const data = JSON.parse(preview);
    expect(data.format).toBe("grove-diagnostics-v1");
    expect(data.privacy.external_upload).toBe(false);
    expect(data.client.connection).toBe("live");
    expect(data.client).not.toHaveProperty("browser");
    expect(generated).toBe(1);
    await page.keyboard.press("Escape");
    const downloadPromise = page.waitForEvent("download");
    await panel.getByRole("link", { name: "진단 묶음 다운로드", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("grove-diagnostics.json");
    expect(await download.failure()).toBeNull();
    expect(await readFile((await download.path())!, "utf8")).toBe(preview);
    await panel.getByRole("button", { name: "진단 묶음 지우기", exact: true }).click();
    await expect(panel.getByRole("link", { name: "진단 묶음 다운로드", exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByLabel("설정 검색", { exact: true }).fill("진단");
    await expect(page.getByTestId("diagnostics-bundle")).toBeVisible();
    await expect(page.getByRole("link", { name: "진단 묶음 다운로드", exact: true })).toHaveCount(0);
    expect(generated).toBe(1);
});

test("진단 요청 오류는 안내하고 확인 범위를 유지해 사용자가 다시 요청한다", async ({ page }) => {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("진단");
    const panel = page.getByTestId("diagnostics-bundle");
    await panel.getByRole("button", { name: "진단 묶음 준비", exact: true }).click();
    await panel.getByLabel("정보 범위를 확인했습니다").check();
    await page.route("**/api/v1/admin/diagnostics", (route) => route.fulfill({
        status: 403, contentType: "application/json",
        body: JSON.stringify({ error: { code: "forbidden", message: "소유자 권한이 필요합니다", retryable: false } }),
    }));
    await panel.getByRole("button", { name: "진단 묶음 생성", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("소유자 권한이 필요합니다");
    await expect(panel.getByLabel("정보 범위를 확인했습니다")).toBeChecked();
    await expect(panel.getByRole("link", { name: "진단 묶음 다운로드", exact: true })).toHaveCount(0);
    await page.unroute("**/api/v1/admin/diagnostics");
    await panel.getByRole("button", { name: "진단 묶음 생성", exact: true }).click();
    await expect(panel.getByRole("link", { name: "진단 묶음 다운로드", exact: true })).toBeVisible();
});
