import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, openSettings, runningSendMode, script, sessionView, state } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`${width}px 실행 중 보내기 설정`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        test("입력창 메뉴 대신 설정에서 선택하며 진행 중 대화와 새로고침 뒤에도 적용한다", async ({ page }, info) => {
            await ensureProfile();
            const title = `running-settings-${width}-${Date.now()}`;
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                root_path: mkdtempSync(join(state().projA, "running-send-")),
            });
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            if (width === 390) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
            const view = sessionView(page, session.id);
            await script({ frames: [], hang: true, marker: title });
            await view.getByLabel("메시지 입력").fill(title);
            await expect(view.getByLabel("메시지 입력")).toHaveValue(title);
            await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
            const response = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/sessions/${session.id}/turns`));
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            const active = ((await (await response).json()) as { turn: { id: string } }).turn.id;
            try {
                await expect(view.getByRole("button", { name: "합치기", exact: true })).toBeVisible();
                await expect(page.getByRole("combobox", { name: "실행 중 보내기 방식", exact: true })).toHaveCount(0);
                await runningSendMode(page, "interrupt");
                await expect(view.getByRole("button", { name: "중단 후 전송", exact: true })).toBeVisible();
                expect((await apiCall<{ status: string }>("GET", `/turns/${active}`)).status).toBe("running");
                await runningSendMode(page, "queue");
                await expect(view.getByRole("button", { name: "대기열", exact: true })).toBeVisible();
                await page.reload();
                await expect(view.getByRole("button", { name: "대기열", exact: true })).toBeVisible();
                await openSettings(page, "local");
                await page.getByLabel("설정 검색", { exact: true }).fill("실행 중 보내기 방식");
                const row = page.getByTestId("setting-running-send");
                await expect(row).toContainText("이 기기");
                await expect(row.getByRole("combobox", { name: "실행 중 보내기 방식", exact: true })).toHaveAttribute("data-selected-value", "queue");
                await expect(row.getByRole("combobox", { name: "실행 중 보내기 방식", exact: true })).toContainText("대기열");
                await expect(row.getByRole("button", { name: /저장|복원/ })).toHaveCount(0);
                await page.screenshot({ path: info.outputPath("running-send-settings.png") });
            } finally { await apiCall("POST", `/turns/${active}/cancel`); }
        });
    });
}
