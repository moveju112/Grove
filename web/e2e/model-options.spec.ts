import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, choiceOptions, closeModelSettings, composerOption, composerSetting, ensureProjects, expectChoice, login, sessionView, state } from "./helpers";

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
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        let active: string | undefined;
        try {
            await login(page);
            await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item")
                .getByRole("button", { name: title, exact: false }).first().click();
            const view = sessionView(page, session.id);
            await composerOption(view, "모델 프로필", profile.id);
            await expect(view.getByTestId("model-effort")).toHaveText("· auto");
            await expect(view.getByRole("img", { name: "Fast 켜짐", exact: true })).toHaveCount(0);
            const reasoning = await composerSetting(view, "추론");
            await test.step("추론 선택지 확인", async () => {
                await expect(await choiceOptions(reasoning)).toHaveText(["auto", "low", "medium", "high", "xhigh", "max", "ultra"]);
                await page.screenshot({ path: info.outputPath(`reasoning-open-${theme}-390.png`) });
            });
            await test.step("추론 목록 닫기", () => page.keyboard.press("Escape"));
            await test.step("max 선택", () => composerOption(view, "추론", "max"));
            await expect(view.getByTestId("model-effort")).toHaveText("· max");
            const speed = await composerSetting(view, "Fast");
            await expectChoice(speed, "false");
            await closeModelSettings(view);
            await expect(view.getByRole("combobox", { name: "속도", exact: true })).toHaveCount(0);
            const geometry = await view.getByTestId("composer-bar").evaluate((node) => ({
                viewport: innerWidth, width: node.clientWidth, scroll: node.scrollWidth,
                right: node.getBoundingClientRect().right,
            }));
            expect(geometry.scroll, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width + 1);
            expect(geometry.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewport);
            await view.getByLabel("메시지 입력").fill("native session seed");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변");
            await expect(view.getByTestId("turn-status")).toHaveCount(0);
            const initialTurns = await apiCall<{ definition: { service_tier: string } }[]>("GET", `/sessions/${session.id}/turns`);
            expect(initialTurns[0]!.definition.service_tier).toBe("default");
            await composerOption(view, "Fast", true);
            const fast = view.getByRole("img", { name: "Fast 켜짐", exact: true });
            await expect(fast).toBeVisible();
            const [modelBounds, effortBounds, fastBounds] = await Promise.all([
                view.getByTestId("model-summary").boundingBox(),
                view.getByTestId("model-effort").boundingBox(),
                fast.boundingBox(),
            ]);
            expect(modelBounds!.x + modelBounds!.width).toBeLessThanOrEqual(effortBounds!.x);
            expect(effortBounds!.x + effortBounds!.width).toBeLessThanOrEqual(fastBounds!.x);
            await expect(fast.locator("svg path")).toHaveAttribute("fill", "currentColor");
            const fastColor = await fast.locator("svg").evaluate((node) => {
                const canvas = document.createElement("canvas").getContext("2d")!;
                const rgb = (color: string) => {
                    canvas.clearRect(0, 0, 1, 1);
                    canvas.fillStyle = color;
                    canvas.fillRect(0, 0, 1, 1);
                    return [...canvas.getImageData(0, 0, 1, 1).data];
                };
                const channels = rgb(getComputedStyle(node).color);
                const luminance = (rgb: number[]) => rgb.slice(0, 3).map((c) => {
                    const value = c / 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
                for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                    const background = rgb(getComputedStyle(parent).backgroundColor);
                    if (background[3] === 255) {
                        const values = [luminance(channels), luminance(background)].sort((a, b) => b - a);
                        return { channels, contrast: (values[0]! + 0.05) / (values[1]! + 0.05) };
                    }
                }
                throw new Error("Fast 아이콘 배경을 찾지 못했습니다");
            });
            const channels = fastColor.channels;
            expect(channels[2]).toBeGreaterThan(channels[0]!);
            expect(channels[2]).toBeGreaterThan(channels[1]!);
            expect(fastColor.contrast).toBeGreaterThanOrEqual(3);
            await page.screenshot({ path: info.outputPath(`model-summary-fast-${theme}-390.png`) });
            await view.getByLabel("메시지 입력").fill("fixture-hold reasoning and fast");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("partial")).toContainText("중단 대기 중");
            const turns = await apiCall<{ id: string; definition: { effort: string; service_tier: string } }[]>("GET", `/sessions/${session.id}/turns`);
            active = turns[0]!.id;
            expect(turns[0]!.definition).toMatchObject({ effort: "max", service_tier: "priority" });
            const request = () => JSON.parse(readFileSync(join(state().cliDir!, "last-request.json"), "utf8")) as { args: string[]; resume: boolean };
            expect(request().args).toEqual(expect.arrayContaining(['model_reasoning_effort="max"', 'service_tier="priority"', "--dangerously-bypass-approvals-and-sandbox"]));
            await expect(view.getByTestId("active-settings")).toHaveCount(0);
            await expect(view.getByTestId("turn-status")).not.toContainText("이번 요청");
            await expect(view.getByTestId("turn-timing")).not.toContainText("총 경과");
            const composer = view.getByTestId("composer");
            expect(await composer.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const timing = (await view.getByTestId("turn-timing").boundingBox())!;
            expect(timing.y + timing.height).toBeLessThanOrEqual((await composer.boundingBox())!.y);
            await page.screenshot({ path: info.outputPath(`running-${theme}-390.png`) });

            await composerOption(view, "추론", "xhigh");
            await composerOption(view, "Fast", false);
            await expect(view.getByTestId("model-effort")).toHaveText("· xhigh");
            await expect(view.getByRole("img", { name: "Fast 켜짐", exact: true })).toHaveCount(0);
            await view.getByRole("button", { name: "초안·스킬", exact: true }).click();
            await expect(view.getByRole("combobox", { name: "실행 중 보내기 방식", exact: true })).toBeVisible();
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
            await composerOption(view, "모델 프로필", JSON.stringify([profile.id, "fixture-light"]));
            await composerSetting(view, "추론");
            await expect((await choiceOptions(reasoning)).filter({ hasText: /^max$/ })).toHaveCount(0);
            await page.keyboard.press("Escape");
            await closeModelSettings(view);
            await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
            await expect(view.getByLabel("메시지 입력")).toHaveValue("모델 변경 후에도 남는 초안");
            await page.reload();
            await expect(sessionView(page, session.id).getByLabel("메시지 입력")).toHaveValue("모델 변경 후에도 남는 초안");
            await expectChoice(await composerSetting(sessionView(page, session.id), "추론"), "xhigh");
        } finally {
            if (active) await apiCall("POST", `/turns/${active}/cancel`);
        }
    });
}
