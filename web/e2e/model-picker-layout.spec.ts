import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, openDetails, script, sessionView, state } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("채팅의 모델 선택은 별도 줄에서 보이고 저장 모드에서도 모델로 전환해 보낸다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const name = `picker-${Date.now()}`;
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "연결 프로필 이름이 길어도 모델을 가리지 않음", protocol: "openai",
        base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-picker-model",
    });
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    try {
        await login(page);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.locator(".recent").getByRole("button", { name }).click();
        const view = sessionView(page, session.id);
        const picker = view.getByLabel("모델 프로필", { exact: true });
        await expect(picker).toBeVisible();
        expect((await picker.boundingBox())!.width).toBeGreaterThan(300);
        await expect(view.getByRole("button", { name: "입력 옵션", exact: true })).toHaveCount(0);
        for (const label of ["보내기 방식", "에이전트", "도구"]) await expect(view.locator(".composer").getByLabel(label, { exact: true })).toHaveCount(0);
        await view.getByLabel("메시지 입력").fill("모델을 바꿔도 남는 초안");
        await composerOption(view, "보내기 방식", "save");
        await expect(picker.locator("option:checked")).toHaveText("메시지만 저장");
        await picker.selectOption(profile.id);
        await expect(picker.locator("option:checked")).toHaveText(/^fixture-picker-model ·/);
        await expect(view.getByLabel("메시지 입력")).toHaveValue("모델을 바꿔도 남는 초안");
        await page.screenshot({ path: info.outputPath("model-picker-390.png") });
        await script({ marker: name, frames: frames.text(["선택한 모델 응답"]) });
        await view.getByLabel("메시지 입력").fill(name);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("선택한 모델 응답");
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        expect(requests.filter((r) => JSON.stringify(r.messages).includes(name)).map((r) => r.model)).toEqual(["fixture-picker-model"]);
    } finally {
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 모델 설정은 상세·도움말로 정리하고 고정 검색창 위로 본문이 비치지 않는다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((theme) => {
            localStorage.setItem("grove.device.prefs", JSON.stringify({ theme }));
        }, theme);
        const profiles: { id: string; name: string }[] = [];
        try {
            for (let i = 0; i < 8; i++) profiles.push(await apiCall("POST", "/model-profiles", {
                name: `간결한 모델 ${i}`, protocol: "codex_cli", base_url: "", model: "default",
            }));
            await login(page);
            await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
            await page.getByLabel("설정 검색").fill("모델 프로필");
            const settings = page.locator(".settings");
            const row = settings.getByTestId("model-profile").filter({ hasText: profiles[0]!.name });
            await expect(row.getByTestId("model-capabilities")).toBeHidden();
            await expect(row.getByText("CLI fallback 미지원")).toBeHidden();
            await expect(settings.getByRole("form", { name: "모델 프로필 추가", exact: true })).toBeHidden();
            await row.getByRole("button", { name: `${profiles[0]!.name} 연결 정보` }).click();
            await expect(page.getByRole("tooltip")).toContainText("서버 CLI 계정");
            await page.keyboard.press("Escape");
            await openDetails(row);
            await row.getByRole("button", { name: "모델 기능 설정", exact: true }).click();
            const context = row.getByLabel("context token 수", { exact: true });
            await context.fill("12345");
            await row.locator("summary").click();
            await row.locator("summary").click();
            await expect(context).toHaveValue("12345");
            await row.getByRole("button", { name: "취소", exact: true }).click();
            await row.locator("summary").click();
            await page.screenshot({ path: info.outputPath(`profiles-${theme}-390.png`) });
            const pane = settings.locator("..");
            await pane.evaluate((node) => { node.scrollTop = 300; });
            const paneBox = (await pane.boundingBox())!;
            const covered = await page.evaluate(({ x, y }) =>
                Boolean(document.elementFromPoint(x, y)?.closest(".settings-nav")),
            { x: paneBox.x + paneBox.width / 2, y: paneBox.y + 2 });
            expect(covered, "검색창 위쪽도 고정 탐색 영역의 불투명 배경으로 덮여야 한다").toBe(true);
            expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`sticky-search-${theme}-390.png`) });
        } finally {
            for (const profile of profiles) await apiCall("DELETE", `/model-profiles/${profile.id}`);
        }
    });
}
