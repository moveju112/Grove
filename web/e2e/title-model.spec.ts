import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, expectChoice, login, openProjectSettings, openSettings, selectChoice, state } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: { server?: { revision: number } } }[] };

for (const width of [390, 1280]) {
    test.describe(`${width}px 제목 생성 모델`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        test("워크플로우 목록에서 프로젝트별 자동 제목과 서버 전체 모델을 독립적으로 저장한다", async ({ page }, info) => {
            const profile = await ensureProfile();
            const titleSetting = (await apiCall<Effective>("GET", "/settings/effective"))
                .items.find((item) => item.key === "session.title_profile")!;
            if (titleSetting.effective !== "") {
                await apiCall("PUT", "/settings/server/-/session.title_profile", {
                    expected_revision: titleSetting.layers.server?.revision ?? 0, value: "",
                });
            }
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                root_path: mkdtempSync(join(state().projA, "title-model-")),
            });
            const effective = async (key: string, projectScoped = true) => (await apiCall<Effective>("GET",
                projectScoped ? `/settings/effective?project_id=${project.id}` : "/settings/effective"))
                .items.find((item) => item.key === key)!.effective;
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
            await openProjectSettings(page);
            const settings = page.getByTestId("settings");
            const conversation = settings.getByRole("button", { name: "대화·컨텍스트", exact: true });
            const basic = settings.getByTestId("setting-basic-definitions");
            const title = basic.getByTestId("workflow-title-generator");
            const row = title.getByTestId("setting-session.title_profile");
            const auto = title.getByTestId("setting-session.auto_title");
            const toggle = auto.getByRole("switch", { name: "대화 제목 자동 생성 사용", exact: true });
            const choice = row.getByRole("button", { name: "제목 생성 모델", exact: true });
            await expect(title.getByRole("button", { name: /대화 제목 자동 생성 (접기|펼치기)/ })).toHaveCount(0);
            const workflow = basic.getByRole("tab", { name: "워크플로우", exact: true });
            await expect(basic.getByRole("switch")).toHaveCount(6);
            await expect(basic.getByRole("switch").first()).toHaveAccessibleName("대화 제목 자동 생성 사용");
            await expect(settings.getByTestId("setting-conversation-title")).toHaveCount(0);
            await expect(settings.getByTestId("setting-memory.enabled")).toHaveCount(1);
            await basic.getByRole("tab", { name: "기본 역할", exact: true }).click();
            await expect(basic.getByRole("switch")).toHaveCount(0);
            await expect(basic.getByTestId("setting-session.title_profile")).toHaveCount(0);
            await expect(basic.getByTestId("definition-title-generator")).toContainText("Title Generator");
            await expect(basic.getByTestId("definition-maintainer")).toContainText("Maintainer");
            await expect(basic.getByTestId("definition-worker")).toHaveCount(0);
            await settings.getByRole("button", { name: "위임 에이전트", exact: true }).click();
            await expect(page.getByTestId("setting-agents.orchestration")).toBeVisible();
            await expect(page.getByTestId("setting-agents.profile.worker")).toBeAttached();
            await expect(page.getByTestId("setting-session.title_profile")).toHaveCount(0);
            await expect(page.getByTestId("setting-definitions").getByRole("button", { name: /^Title Generator/ })).toHaveCount(0);
            await conversation.click();
            await expect(settings.getByTestId("setting-session.auto_title")).toHaveCount(0);
            await settings.getByRole("button", { name: "워크플로우·메모리", exact: true }).click();
            await expect(workflow).toHaveAttribute("aria-selected", "true");
            await expect(row).toBeVisible();
            await expect(settings.getByTestId("setting-session.title_profile")).toHaveCount(1);
            await expect(row).toHaveAttribute("data-settings-target", "서버 전체");
            await expect(auto).toHaveAttribute("data-settings-target", `프로젝트 “${project.name}”`);
            await expectChoice(choice, "");
            await expect(choice).toContainText("모델 선택");
            await expect(row).toContainText("모델을 선택하기 전에는 기존 제목이 유지돼요.");
            await choice.click();
            await expect(page.getByRole("menuitemradio", { name: "사용 안 함", exact: true })).toHaveCount(0);
            await expect(page.getByRole("menuitemradio", { name: "모델 선택", exact: true })).toHaveCount(0);
            await page.keyboard.press("Escape");
            await selectChoice(choice, profile);
            await expect(title).toContainText("저장됨");
            await expect.poll(() => effective("session.title_profile", false)).toBe(profile);
            // 한도 소진 시 대체 모델은 같은 카드에서 따로 저장하고, 기본은 전환하지 않는다.
            const fallbackChoice = title.getByTestId("setting-session.title_fallback")
                .getByRole("button", { name: "제목 생성 한도 소진 시 모델", exact: true });
            await expectChoice(fallbackChoice, "");
            await expect(fallbackChoice).toContainText("전환 안 함");
            await selectChoice(fallbackChoice, profile);
            await expect.poll(() => effective("session.title_fallback", false)).toBe(profile);
            await selectChoice(fallbackChoice, "");
            await expect.poll(() => effective("session.title_fallback", false)).toBe("");
            await expect(toggle).not.toBeChecked();
            const serverFlag = await effective("session.auto_title", false);
            await toggle.click();
            await expect.poll(() => effective("session.auto_title")).toBe(true);
            await expect(toggle).toBeChecked();
            await expect(row).toBeVisible();
            await toggle.click();
            await expect.poll(() => effective("session.auto_title")).toBe(false);
            expect(await effective("session.auto_title", false)).toBe(serverFlag);
            await page.reload();
            await openProjectSettings(page);
            await expectChoice(choice, profile);
            await expect(toggle).not.toBeChecked();
            await toggle.click();
            await expect.poll(() => effective("session.auto_title")).toBe(true);
            await expectChoice(choice, profile);
            await page.screenshot({ path: info.outputPath("workflow-model.png") });
        });
    });
}

test("비활성 역할은 모델 저장에 실패하면 켜지지 않고, 재확인 뒤 같은 선택으로 켠다", async ({ page }) => {
    const profile = await ensureProfile();
    const original = await apiCall<{ revision: number; enabled: boolean }>("GET", "/definitions/agent/worker");
    await apiCall("PUT", "/definitions/agent/worker", { expected_revision: original.revision, enabled: false });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
        await page.getByLabel("설정 검색").fill("Worker 모델");
        const row = page.getByTestId("setting-agents.profile.worker");
        await expect(page.getByTestId("definition-worker").getByTestId("setting-agents.profile.worker")).toHaveCount(1);
        const choice = row.getByRole("button", { name: "Worker 모델", exact: true });
        const path = "**/api/v1/settings/server/-/agents.profile.worker";
        await page.route(path, (route) => route.fulfill({ status: 503, json: { error: { code: "result_unknown", message: "모델 저장 결과 확인 필요", retryable: true } } }), { times: 1 });
        await selectChoice(choice, profile);
        await expect(row).toContainText("저장 결과를 확인하지 못했어요");
        expect((await apiCall<{ enabled: boolean }>("GET", "/definitions/agent/worker")).enabled).toBe(false);
        await page.getByLabel("설정 검색").fill("요청당 시간 예산");
        await expect(row).toHaveCount(0);
        await page.getByLabel("설정 검색").fill("Worker 모델");
        await expectChoice(choice, profile);
        await row.getByRole("button", { name: "요청 결과 확인", exact: true }).click();
        await expect.poll(async () => (await apiCall<{ enabled: boolean }>("GET", "/definitions/agent/worker")).enabled).toBe(true);
        await expectChoice(choice, profile);
        await page.evaluate(() => history.replaceState(history.state, "", "#setting-agents.profile.worker"));
        await page.reload();
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await expect(page.getByTestId("settings").getByRole("button", { name: "위임 에이전트", exact: true })).toHaveAttribute("aria-current", "page");
        await expectChoice(choice, profile);
        await expect(row).toBeInViewport();
        await expect(page.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
    } finally {
        const current = await apiCall<{ revision: number }>("GET", "/definitions/agent/worker");
        await apiCall("PUT", "/definitions/agent/worker", { expected_revision: current.revision, enabled: original.enabled });
    }
});

for (const width of [390, 1280]) {
    test.describe(`${width}px 역할별 실제 모델`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        test("하나의 default 연결에서 역할마다 다른 모델과 추론 강도를 고르고 복원한다", async ({ page }, info) => {
            test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI 모델 목록 fixture 필요");
            const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
                name: `역할 모델 ${width}`, protocol: "codex_cli", base_url: "", model: "default",
            });
            await login(page);
            await openSettings(page);
            for (const [key,label,model,effort] of [
                ["session.title_profile","제목 생성 모델","fixture-light","low"],
                ["memory.profile","메모리 정리 모델","gpt-5.6"],
                ["context.summary_profile","압축 요약 모델","fixture-codex","xhigh"],
                ["agents.profile.worker","Worker 모델","gpt-6.1"],
            ] as const) {
                await page.getByLabel("설정 검색").fill(label!);
                const row = page.getByTestId(`setting-${key}`);
                const choice = row.getByRole("button", { name: label!, exact: true });
                const value = JSON.stringify([profile.id,model]);
                await selectChoice(choice,value);
                const saved = () => expect.poll(async () => (await apiCall<Effective>("GET","/settings/effective"))
                    .items.find(item => item.key === key)!.effective);
                await saved().toEqual({profile_id:profile.id,model});
                const effortChoice = row.getByRole("combobox", { name: `${label} 추론 강도`, exact: true });
                if (effort) {
                    await selectChoice(effortChoice, effort);
                    await saved().toEqual({profile_id:profile.id,model,effort});
                }
                // Fast는 속도 목록을 제공한 모델에서만 보이고, 추론 강도와 함께 저장된다.
                const fast = row.getByRole("switch", { name: `${label} Fast`, exact: true });
                const withFast = key === "context.summary_profile";
                const selected = withFast ? {profile_id:profile.id,model,effort,service_tier:"priority"} : {profile_id:profile.id,model,...(effort ? {effort} : {})};
                if (withFast) {
                    await expect(fast).not.toBeChecked();
                    await fast.click();
                    await saved().toEqual(selected);
                } else await expect(fast).toHaveCount(0);
                await expect(choice).toContainText(model!);
                await page.reload();
                await openSettings(page);
                await page.getByLabel("설정 검색").fill(label!);
                await expectChoice(choice,value);
                if (effort) await expectChoice(effortChoice, effort);
                if (withFast) await expect(fast).toBeChecked();
                if (key === "context.summary_profile") {
                    const role = page.getByTestId("workflow-context-compressor");
                    const toggle = role.getByRole("switch", { name: "컨텍스트 압축 사용" });
                    const enabled = () => apiCall<{enabled:boolean}>("GET","/definitions/agent/context-compressor").then((d) => d.enabled);
                    const original = await enabled();
                    if (!original) { await toggle.click(); await expect.poll(enabled).toBe(true); }
                    await toggle.click();
                    await expect.poll(enabled).toBe(false);
                    await saved().toEqual(selected);
                    await expectChoice(choice, value);
                    await expectChoice(effortChoice, effort!);
                    const [modelBox, effortBox] = await Promise.all([choice.boundingBox(), effortChoice.boundingBox()]);
                    expect(modelBox).not.toBeNull();
                    expect(effortBox).not.toBeNull();
                    if (width === 390) expect(effortBox!.y).toBeGreaterThanOrEqual(modelBox!.y + modelBox!.height);
                    else expect(effortBox!.x).toBeGreaterThanOrEqual(modelBox!.x + modelBox!.width);
                    await selectChoice(effortChoice, "high");
                    await saved().toEqual({ ...selected, effort: "high" });
                    await expect(fast).toBeChecked();
                    await selectChoice(effortChoice, effort!);
                    await toggle.click();
                    await expect.poll(enabled).toBe(true);
                    await expectChoice(effortChoice, effort!);
                    await expect(fast).toBeChecked();
                    if (!original) { await toggle.click(); await expect.poll(enabled).toBe(false); }
                    await choice.scrollIntoViewIfNeeded();
                    await page.screenshot({path:info.outputPath("role-models.png")});
                    expect(await page.getByTestId("settings").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
                }
            }
            expect((await apiCall<{id:string;model:string}[]>("GET","/model-profiles")).find(p => p.id === profile.id)!.model).toBe("default");
        });
    });
}
