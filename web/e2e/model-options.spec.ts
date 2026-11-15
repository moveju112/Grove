import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, sessionView, state } from "./helpers";

test.use({ isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`390px ${theme}: Codex 추론·Fast를 실제 CLI 인자와 대기열에 보존하고 입력 카드가 넘치지 않는다`, async ({ page }, info) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        const { a } = await ensureProjects();
        const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
            name: `options-${theme}`, protocol: "codex_cli", base_url: "", model: "fixture-codex",
        });
        const title = `추론과 속도 ${theme}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        let active: string | undefined;
        try {
            await login(page);
            await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("sidebar-session").filter({ has: page.getByRole("button", { name: title, exact: false }) })
                .getByRole("button", { name: title, exact: false }).first().click();
            const view = sessionView(page, session.id);
            const model = view.getByLabel("모델 프로필", { exact: true });
            await model.selectOption(profile.id);
            const reasoning = view.getByLabel("추론", { exact: true });
            await expect(reasoning.locator("option")).toHaveText(["auto", "low", "medium", "high", "xhigh", "max", "ultra"]);
            await reasoning.selectOption("max");
            const speed = view.getByRole("button", { name: "Fast", exact: true });
            await expect(speed).toHaveAttribute("aria-pressed", "false");
            await expect(speed).toHaveText("");
            await expect(view.getByRole("combobox", { name: "속도", exact: true })).toHaveCount(0);
            await view.getByLabel("메시지 입력").fill("native session seed");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변");
            await expect(view.getByTestId("turn-status")).toHaveCount(0);
            const initialTurns = await apiCall<{ definition: { service_tier: string } }[]>("GET", `/sessions/${session.id}/turns`);
            expect(initialTurns[0]!.definition.service_tier).toBe("default");
            await speed.click();
            await expect(speed).toHaveAttribute("aria-pressed", "true");
            await view.getByLabel("메시지 입력").fill("fixture-hold reasoning and fast");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("partial")).toContainText("중단 대기 중");
            const turns = await apiCall<{ id: string; definition: { effort: string; service_tier: string } }[]>("GET", `/sessions/${session.id}/turns`);
            active = turns[0]!.id;
            expect(turns[0]!.definition).toMatchObject({ effort: "max", service_tier: "priority" });
            const request = () => JSON.parse(readFileSync(join(state().cliDir!, "last-request.json"), "utf8")) as { args: string[]; resume: boolean };
            expect(request().args).toEqual(expect.arrayContaining(['model_reasoning_effort="max"', 'service_tier="priority"', 'sandbox_mode="read-only"']));
            await expect(view.getByTestId("active-settings")).toHaveCount(0);
            await expect(view.getByTestId("turn-status")).not.toContainText("이번 요청");
            await expect(view.getByTestId("turn-timing")).not.toContainText("총 경과");
            const composer = view.locator(".composer");
            expect(await composer.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const timing = (await view.getByTestId("turn-timing").boundingBox())!;
            expect(timing.y + timing.height).toBeLessThanOrEqual((await composer.boundingBox())!.y);
            await page.screenshot({ path: info.outputPath(`running-${theme}-390.png`) });

            await reasoning.selectOption("xhigh");
            await speed.click();
            await expect(speed).toHaveAttribute("aria-pressed", "false");
            await view.getByRole("button", { name: "초안·스킬", exact: true }).click();
            await expect(view.getByLabel("실행 중 보내기 방식")).toBeVisible();
            await page.keyboard.press("Escape");
            await view.getByLabel("메시지 입력").fill("queued reasoning and normal");
            await view.getByRole("button", { name: "대기열에 추가", exact: true }).click();
            const queued = await apiCall<{ items: { id: string; effort: string; service_tier: string }[] }>("GET", `/sessions/${session.id}/followups`);
            expect(queued.items[0]).toMatchObject({ effort: "xhigh", service_tier: "default" });
            await apiCall("POST", `/turns/${active}/cancel`);
            await expect(view.getByTestId("turn-status")).toHaveCount(0);
            active = undefined;
            await apiCall("POST", `/sessions/${session.id}/followups/${queued.items[0]!.id}/start`);
            await expect(view.getByTestId("msg-assistant")).toHaveCount(2);
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변");
            expect(request().args).toEqual(expect.arrayContaining(['model_reasoning_effort="xhigh"', 'service_tier="default"']));
            expect(request().resume).toBe(true);
            await view.getByLabel("메시지 입력").fill("모델 변경 후에도 남는 초안");
            await model.selectOption(JSON.stringify([profile.id, "fixture-light"]));
            await expect(reasoning.locator('option[value="max"]')).toHaveCount(0);
            await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
            await expect(view.getByLabel("메시지 입력")).toHaveValue("모델 변경 후에도 남는 초안");
            await page.reload();
            await expect(sessionView(page, session.id).getByLabel("메시지 입력")).toHaveValue("모델 변경 후에도 남는 초안");
            await expect(sessionView(page, session.id).getByLabel("추론", { exact: true })).toHaveValue("xhigh");
        } finally {
            if (active) await apiCall("POST", `/turns/${active}/cancel`);
        }
    });
}
