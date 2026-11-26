import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, openDetails, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "GROVE_E2E_FAKE_CLI=1로 실행");

for (const mode of ["expanded", "collapse"] as const) {
    test(`합치기 전후 진행 설명의 위치와 완료 시 표시: ${mode}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await page.addInitScript((progressVisibility) => localStorage.setItem("grove.device.prefs", JSON.stringify({ progressVisibility, clock: "24h" })), mode);
        const { a } = await ensureProjects();
        const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
        const marker = randomUUID();
        const title = `합치기 화면 ${mode} ${marker.slice(0, 8)}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") === "false") await sidebar.click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
        const view = sessionView(page, session.id);
        const { turn } = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
            text: `fixture-followup-${marker} fixture-steer-timeline`, profile_id: profile.id, tools: false,
        });
        const folder = state().cliDir!;
        const release = join(folder, `followup-release-${marker}`);
        const before = view.getByTestId("pre-steer-progress");
        const steer = view.getByTestId("msg-user").filter({ hasText: "참고로 gpt에선 잘돼" });
        const after = view.getByTestId("msg-assistant");
        const verifyOrder = async (afterTestId: string) => {
            await expect(steer).toBeVisible();
            const beforeBox = await before.boundingBox();
            const steerBox = await steer.boundingBox();
            const afterBox = await view.getByTestId(afterTestId).boundingBox();
            expect(beforeBox!.y + beforeBox!.height).toBeLessThanOrEqual(steerBox!.y);
            expect(steerBox!.y + steerBox!.height).toBeLessThanOrEqual(afterBox!.y);
        };
        try {
            await expect.poll(() => existsSync(join(folder, `followup-ready-${marker}`))).toBe(true);
            await apiCall("POST", `/sessions/${session.id}/followups`, { kind: "steer", text: "참고로 gpt에선 잘돼", profile_id: profile.id, tools: false });
            await expect(before.getByTestId("progress-step").getByRole("paragraph")).toHaveText(["합치기 전 첫 확인.", "합치기 전 두 번째 확인."]);
            const live = view.getByTestId("partial");
            await expect(live.getByTestId("progress-step").getByRole("paragraph")).toHaveText(["합친 뒤 첫 확인.", "합친 뒤 두 번째 확인."]);
            for (const block of [before.getByTestId("msg-progress"), live.getByTestId("partial-progress")]) {
                await expect(block.getByText("진행 설명", { exact: true })).toBeVisible();
                await expect(block.locator("time")).toHaveCount(0);
            }
            await expect(live.getByRole("list", { name: "진행 설명 순서" })).toHaveAttribute("start", "3");
            await verifyOrder("partial");
            writeFileSync(release, "");
            await expect(after.getByTestId("msg-answer")).toBeVisible();
            await expect(live).toHaveCount(0);
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.id}`)).status).toBe("completed");
            await verifyOrder("msg-assistant");
            if (mode === "collapse") {
                for (const block of [before, after]) {
                    await expect(block.getByTestId("progress-step")).toHaveCount(0);
                    await expect(block.getByTestId("msg-progress").getByRole("button")).toBeVisible();
                }
                await openDetails(after.getByTestId("msg-progress"));
                await expect(page.getByRole("dialog", { name: "진행 설명" }).getByRole("list")).toHaveAttribute("start", "3");
                await page.keyboard.press("Escape");
            } else {
                await expect(before.getByTestId("progress-step").locator("time")).toHaveCount(2);
                await expect(after.getByTestId("progress-step").locator("time")).toHaveCount(2);
                await expect(after.getByRole("list", { name: "진행 설명 순서" })).toHaveAttribute("start", "3");
            }
            await page.screenshot({ path: info.outputPath(`steer-timeline-${mode}.png`), animations: "disabled" });
            await page.reload();
            await expect(after.getByTestId("msg-answer")).toBeVisible();
            await verifyOrder("msg-assistant");
            for (const block of [before, after]) await expect(block.getByTestId("progress-step")).toHaveCount(mode === "collapse" ? 0 : 2);
        } finally {
            writeFileSync(release, "");
            const current = await apiCall<{ status: string }>("GET", `/turns/${turn.id}`);
            if (["queued", "running", "awaiting_approval"].includes(current.status)) await apiCall("POST", `/turns/${turn.id}/cancel`);
        }
    });
}
