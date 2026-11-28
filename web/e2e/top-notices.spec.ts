import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, openSettings, script, selectChoice, sessionView } from "./helpers";

// 다른 대화를 보고 있을 때 끝난 답변은 상단 배너로 알린다. 표시 시간과 표시 여부는 종류마다 기기 설정을 따른다.
async function watchOne(page: Page) {
    const { a } = await ensureProjects();
    const profileId = await ensureProfile();
    const stamp = Date.now();
    const shown = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `보는 대화 ${stamp}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: shown.id });
    await login(page);
    const narrow = page.viewportSize()!.width <= 760;
    if (narrow) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`보는 대화 ${stamp}`) }).first().click();
    if (narrow) await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();
    await expect(sessionView(page, shown.id)).toBeVisible();
    // 열어 두지 않은 다른 대화에서 답변을 끝낸다.
    const answer = async (title: string, text: string) => {
        const other = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${title} ${stamp}` });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: other.id });
        const marker = `끝나면 알려 줘 ${other.id}`;
        await script({ marker, frames: frames.text([text]) });
        await apiCall("POST", `/sessions/${other.id}/turns`, { profile_id: profileId, tools: false, text: marker });
        return other.id;
    };
    return { shown: shown.id, answer };
}

async function topNoticeSetting(page: Page, name: string, value: string, screenshot?: string) {
    await openSettings(page, "local");
    const settings = page.getByTestId("settings");
    await settings.getByRole("button", { name: "알림", exact: true }).click();
    const panel = settings.getByTestId("setting-top-notice");
    const control = panel.getByRole("combobox", { name, exact: true });
    await selectChoice(control, value);
    await expect(control).toHaveAttribute("data-selected-value", value);
    if (screenshot) {
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: screenshot });
    }
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
}

test("다른 대화의 답변 완료는 상단 배너로 알리고, 누르면 그 대화를 연다", async ({ page }, info) => {
    const { shown, answer } = await watchOne(page);
    const finished = await answer("끝난 대화", "배포 준비를 마쳤어요");
    const notice = page.getByTestId("done-notice");
    await expect(notice).toHaveCount(1, { timeout: 15_000 });
    await expect(notice).toContainText("완료 · 배포 준비를 마쳤어요");
    await expect(notice.getByTestId("done-notice-timer")).toBeAttached();
    await page.screenshot({ path: info.outputPath("done-notice-desktop.png") });
    await notice.getByRole("button", { name: /완료 · 배포 준비를/ }).click();
    await expect(notice).toHaveCount(0);
    await expect(sessionView(page, finished).getByTestId("msg-assistant").filter({ hasText: "배포 준비를 마쳤어요" })).toBeVisible({ timeout: 15_000 });

    // 보고 있는 대화의 답변은 화면에 이미 보이므로 배너를 띄우지 않는다.
    const marker = `보는 중에 답해 줘 ${finished}`;
    await script({ marker, frames: frames.text(["보는 중에 끝남"]) });
    await apiCall("POST", `/sessions/${finished}/turns`, { profile_id: await ensureProfile(), tools: false, text: marker });
    await expect(sessionView(page, finished).getByTestId("msg-assistant").filter({ hasText: "보는 중에 끝남" })).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveCount(0);
    await expect(sessionView(page, shown)).toHaveCount(0);
});

test("상단 알림은 설정에서 끄면 뜨지 않고, 고른 시간 뒤 닫힌다", async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { answer } = await watchOne(page);
    const notice = page.getByTestId("done-notice");
    const recent = page.getByRole("region", { name: "최근", exact: true });

    await topNoticeSetting(page, "답변 완료 알림", "0");
    const quiet = await answer("조용히 끝난 대화", "알리지 않는 답변");
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await expect(recent.locator(`[data-testid="recent-item"][data-session="${quiet}"]`)).toHaveAttribute("data-recent-state", "completed", { timeout: 15_000 });
    await expect(notice).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mobile-drawer-left")).toBeHidden();

    await topNoticeSetting(page, "답변 완료 알림", "5", info.outputPath("top-notice-settings-390.png"));
    await answer("알리고 끝난 대화", "다섯 번째 초에 닫히는 답변입니다. 길어도 한 줄로 줄여 보여 주고 전체 문구는 툴팁으로 확인합니다.");
    // 설정을 닫은 자리에 남은 포인터가 배너를 가리키면 시간이 멈추므로 먼저 치운다.
    await page.mouse.move(195, 700);
    await expect(notice).toHaveCount(1, { timeout: 15_000 });
    const appeared = Date.now();
    const box = (await notice.boundingBox())!;
    expect(box.height, "한 줄 배너").toBeLessThanOrEqual(64);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("done-notice-390.png") });
    await expect(notice).toHaveCount(0, { timeout: 9_000 });
    expect(Date.now() - appeared).toBeGreaterThan(4_000);
});

test("오류 알림을 끄면 연결 오류 배너는 뜨지 않고 전송 차단은 유지한다", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ noticeErrorSeconds: 0 })));
    const { shown } = await watchOne(page);
    const view = sessionView(page, shown);
    await view.getByLabel("메시지 입력", { exact: true }).fill("알림이 없어도 남을 입력");
    const send = view.getByRole("button", { name: "보내기", exact: true });
    await expect(send).toBeEnabled();
    await page.route("**/api/v1/health", route => route.abort("connectionrefused"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(send).toBeDisabled();
    await expect(page.getByTestId("connection-toast")).toHaveCount(0);
    await page.unroute("**/api/v1/health");
    await expect(send).toBeEnabled({ timeout: 7_000 });
});
