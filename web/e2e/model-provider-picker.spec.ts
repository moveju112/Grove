import { expect, test } from "@playwright/test";
import { apiCall, closeModelSettings, composerOption, composerSetting, ensureProfile, ensureProjects, login, sessionView, state } from "./helpers";

for (const mobile of [false, true]) {
    test.describe(mobile ? "390px" : "desktop", () => {
        test.use({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });

        test("공급자는 목록만 열고 실제 모델을 골라야 선택이 바뀐다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const initial = await ensureProfile();
            const codex = await apiCall<{ id: string }>("POST", "/model-profiles", {
                name: "Codex", protocol: "codex_cli", base_url: "", model: "default",
            });
            const claude = await apiCall<{ id: string }>("POST", "/model-profiles", {
                name: "Claude", protocol: "claude_code", base_url: "", model: "default",
            });
            const literal = await apiCall<{ id: string }>("POST", "/model-profiles", {
                name: "Literal API model", protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "default",
            });
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `provider-picker-${mobile}` });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme: "dark" })));
            try {
                await login(page);
                if (mobile) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                await page.getByRole("region", { name: "최근", exact: true })
                    .getByRole("button", { name: `provider-picker-${mobile}` }).click();
                const view = sessionView(page, session.id);
                await composerOption(view, "모델 프로필", initial);
                await view.getByLabel("메시지 입력").fill("모델 목록을 둘러봐도 남는 초안");
                const picker = await composerSetting(view, "모델 프로필");
                const summary = view.getByTestId("model-summary");
                await expect(summary).toHaveText("fixture-model");
                await picker.click();
                const codexCategory = page.getByRole("menuitem", { name: "Codex", exact: true });
                await expect(codexCategory).not.toHaveAttribute("aria-checked");
                if (mobile) await codexCategory.click();
                else { await codexCategory.focus(); await codexCategory.press("ArrowRight"); }
                const codexModels = page.getByTestId(`model-profile-models-${codex.id}`);
                await expect(codexModels.getByRole("menuitemradio", { name: "Fixture Light", exact: true })).toBeVisible();
                await expect(codexModels.getByRole("menuitemradio")).toHaveText([
                    "GPT-6.1", "GPT-5.10", "GPT-5.6", "Fixture Codex", "Fixture Light",
                ]);
                await expect(codexModels).not.toContainText("기본 모델");
                await expect(picker).toHaveAttribute("data-selected-value", initial);
                await expect(summary).toHaveText("fixture-model");
                await page.screenshot({ path: info.outputPath(`model-provider-${mobile ? "390" : "desktop"}.png`) });
                await codexModels.getByRole("menuitemradio", { name: "Fixture Light", exact: true }).click();
                const chosenCodex = JSON.stringify([codex.id, "fixture-light"]);
                await expect(picker).toHaveAttribute("data-selected-value", chosenCodex);
                await expect(summary).toHaveText("Fixture Light");

                await picker.click();
                await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
                const claudeModels = page.getByTestId(`model-profile-models-${claude.id}`);
                await expect(claudeModels.getByRole("menuitemradio", { name: "Fixture Claude", exact: true })).toBeVisible();
                await expect(claudeModels.getByRole("menuitemradio")).toHaveText(["Opus 5.5", "Fixture Claude"]);
                await expect(claudeModels).not.toContainText("기본 모델");
                await expect(picker).toHaveAttribute("data-selected-value", chosenCodex);
                await expect(summary).toHaveText("Fixture Light");
                await claudeModels.getByRole("menuitemradio", { name: "Fixture Claude", exact: true }).click();
                const chosenClaude = JSON.stringify([claude.id, "fixture-claude"]);
                await expect(picker).toHaveAttribute("data-selected-value", chosenClaude);
                await expect(summary).toHaveText("Fixture Claude");
                await closeModelSettings(view);
                await expect(view.getByLabel("메시지 입력")).toHaveValue("모델 목록을 둘러봐도 남는 초안");
                await page.reload();
                const restored = sessionView(page, session.id);
                await expect(restored.getByTestId("model-summary")).toHaveText("Fixture Claude");
                await expect(await composerSetting(restored, "모델 프로필")).toHaveAttribute("data-selected-value", chosenClaude);
                await (await composerSetting(restored, "모델 프로필")).click();
                await page.getByRole("menuitem", { name: "Literal API model", exact: true }).click();
                await expect(page.getByTestId(`model-profile-models-${literal.id}`).getByRole("menuitemradio", { name: "default", exact: true })).toBeVisible();
                const profiles = await apiCall<{ id: string; model: string }[]>("GET", "/model-profiles");
                expect(profiles.find((p) => p.id === codex.id)!.model).toBe("default");
                expect(profiles.find((p) => p.id === claude.id)!.model).toBe("default");
            } finally {
                await apiCall("DELETE", `/model-profiles/${codex.id}`);
                await apiCall("DELETE", `/model-profiles/${claude.id}`);
                await apiCall("DELETE", `/model-profiles/${literal.id}`);
            }
        });
    });
}
