import { expect, test } from "@playwright/test";
import { apiCall, closeModelSettings, composerOption, composerSetting, ensureProjects, login, modelSettings, sessionView, state } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 모바일 모델·전송 조작은 긴 이름·글자 확대·축소 화면에서도 가려지지 않는다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
        const { a } = await ensureProjects();
        const profiles = [];
        for (const model of ["gpt-6.1-sol", "gpt-6.1-sol-very-long-model-name-for-a-small-mobile-screen"]) {
            profiles.push(await apiCall<{ id: string; model: string }>("POST", "/model-profiles", {
                name: `모델명과 다른 연결 계정 ${theme} ${profiles.length}`,
                protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model,
            }));
        }
        const title = `입력창 폭 확인 ${theme}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        try {
            await login(page);
            await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).click();
            const view = sessionView(page, session.id);
            const toolbar = view.getByTestId("composer-bar");
            const input = view.getByLabel("메시지 입력", { exact: true });
            await input.fill("모델과 화면 폭을 바꿔도 보존할 초안");
            for (const width of [360, 390]) {
                await page.setViewportSize({ width, height: 844 });
                await composerOption(view, "모델 프로필", profiles[0]!.id);
                await expect(view.getByTestId("model-summary")).toHaveText(profiles[0]!.model);
                await expect(toolbar.getByRole("button")).toHaveCount(4);
                await expect(toolbar.getByRole("button", { name: "context 사용량", exact: true })).toBeVisible();
                await expect(toolbar.getByRole("combobox")).toHaveCount(0);
                await composerOption(view, "추론", "high");
                const settings = await modelSettings(view);
                await expect(settings.getByRole("combobox", { name: "추론", exact: true })).toHaveAttribute("data-selected-value", "high");
                await expect(settings.getByRole("combobox", { name: "Fast", exact: true })).toHaveCount(0);
                await expect(settings).toBeInViewport();
                await page.screenshot({ path: info.outputPath(`model-settings-${theme}-${width}.png`) });
                await page.keyboard.press("Escape");
                await expect(view.getByRole("button", { name: "모델 설정", exact: true })).toBeFocused();
                await expect.poll(() => toolbar.evaluate((node) => {
                    const trigger = node.querySelector<HTMLButtonElement>('button[aria-label="모델 설정"]')!;
                    const summary = node.querySelector<HTMLElement>('[data-testid="model-summary"]')!;
                    const effort = node.querySelector<HTMLElement>('[data-testid="model-effort"]')!;
                    return trigger.getBoundingClientRect().width - summary.getBoundingClientRect().width - effort.getBoundingClientRect().width;
                }), { message: "짧은 모델 버튼은 내용과 여백만큼만 너비를 사용한다" }).toBeLessThanOrEqual(32);
                await page.screenshot({ path: info.outputPath(`composer-${theme}-${width}-compact.png`) });

                await composerOption(view, "모델 프로필", profiles[1]!.id);
                for (const height of [844, 460, 844]) {
                    await page.setViewportSize({ width, height });
                    await input.focus();
                    await expect.poll(() => toolbar.evaluate((node) => {
                        const composer = node.closest<HTMLElement>('[data-testid="composer"]')!;
                        const model = node.querySelector<HTMLElement>('[data-testid="model-summary"]')!;
                        const attach = node.querySelector<HTMLButtonElement>('button[aria-label="파일 첨부"]')!;
                        const modelBox = model.getBoundingClientRect();
                        const attachBox = attach.getBoundingClientRect();
                        const buttons = [...node.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.getBoundingClientRect().width > 0);
                        return {
                            expandedAboveActions: modelBox.bottom <= attachBox.top + 1,
                            readable: model.scrollWidth <= model.clientWidth + 1,
                            insideViewport: buttons.every((button) => {
                                const box = button.getBoundingClientRect();
                                return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
                            }),
                            touchTargets: buttons.every((button) => {
                                const box = button.getBoundingClientRect();
                                return box.width >= 32 && box.height >= 32
                                    && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("button") === button;
                            }),
                            // Astryx의 투명한 44px 터치 확장은 카드 안에서 허용한다. 실제 카드·페이지는 넘치면 안 된다.
                            noOverflow: composer.scrollWidth <= composer.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
                        };
                    })).toEqual({ expandedAboveActions: true, readable: true, insideViewport: true, touchTargets: true, noOverflow: true });
                    await expect(input).toHaveValue("모델과 화면 폭을 바꿔도 보존할 초안");
                }
                await page.addStyleTag({ content: '[data-testid="composer"] button { font-size: 20px; }' });
                await expect(view.getByTestId("model-summary")).toHaveText(profiles[1]!.model);
                await expect.poll(() => view.getByTestId("model-summary").evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
                await page.screenshot({ path: info.outputPath(`composer-${theme}-${width}-large-text.png`) });
                await composerSetting(view, "모델 프로필");
                await closeModelSettings(view);
            }
        } finally {
            for (const profile of profiles) await apiCall("DELETE", `/model-profiles/${profile.id}`);
        }
    });
}
