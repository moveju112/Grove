import { expect, test, type Locator } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, openDetails, script, sessionView, state } from "./helpers";

async function expectFailureLayout(view: Locator, width: number) {
    const err = view.getByTestId("turn-ended");
    await expect(err).toBeVisible();
    await expect(view.getByTestId("composer")).toBeVisible();
    await expect(err.getByTestId("turn-timing")).toContainText("소요 시간");
    await expect(view.getByTestId("turn-timing")).toHaveCount(1);
    await expect(err.getByTestId("turn-timing")).not.toContainText("실패");
    await expect(view.locator("[data-session-msgs]").getByTestId("msg-turn-ended")).toHaveCount(0);
    const error = (await err.boundingBox())!;
    const composer = (await view.getByTestId("composer").boundingBox())!;
    expect(Math.abs(error.x - composer.x)).toBeLessThan(2);
    expect(Math.abs(error.width - composer.width)).toBeLessThan(2);
    expect(error.x).toBeGreaterThanOrEqual(0);
    expect(error.x + error.width).toBeLessThanOrEqual(width);
    expect(error.y + error.height).toBeLessThanOrEqual(composer.y);
    expect(await err.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

// UI-006: 실패한 요청은 원인 메시지와 함께 오류로 표시하고, 자동으로 다시 실행하지 않는다고 알린다.
test("실패한 요청은 원인과 함께 오류로 표시된다", async ({ page }, info) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `오류 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    // 재시도하지 않는 모델 오류(400)로 첫 응답에서 실패
    await script({ frames: [], status: 400, error: "fixture rejected request" });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("길게 답해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const err = view.getByTestId("turn-ended");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).toHaveAttribute("role", "alert");
    await expect(err).toContainText("요청이 실패했어요");
    await expect(err).toContainText("fixture rejected request");
    await expect(err).toContainText("자동으로 다시 실행하지 않아요");
    // 같은 실패는 입력창 위 한 곳에만 표시하고, 모바일에서도 입력창과 읽기 폭을 맞춘다.
    await expect(view.locator("[data-session-msgs]").getByTestId("msg-turn-ended")).toHaveCount(0);
    await expectFailureLayout(view, 1400);
    await page.screenshot({ path: info.outputPath("turn-error-1400.png") });
    const cause = view.getByTestId("msg-turn-ended").first();
    await openDetails(cause);
    await expect(cause).toContainText("bad_request");
    await expect(cause).toContainText("발생 시각:");
    await expect(cause).toContainText("마지막 진행:");
    // RUN-024: 진행 범위·다음 조치는 상세에 보존하고 새로고침 뒤에도 같다.
    await expect(cause.getByTestId("end-scope")).toContainText("진행 범위: 모델 응답 1단계 · 최종 답변 없음");
    await expect(cause.getByTestId("end-scope")).toContainText("다음 조치:");
    await page.reload();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    await openDetails(cause);
    await expect(cause.getByTestId("end-scope")).toContainText("진행 범위: 모델 응답 1단계");
    await page.keyboard.press("Escape");

    // RUN-019: '다시 실행'하면 같은 글로 새 요청을 보낸다
    await script({ frames: frames.text(["다시 실행한 답"]) });
    await err.getByRole("button", { name: "다시 실행" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "다시 실행한 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("turn-ended")).toHaveCount(0);
    await expect(view.getByTestId("msg-user").filter({ hasText: "길게 답해" })).toHaveCount(2);
    await expect(cause).toContainText("bad_request");

    // 다시 실패시키고 '닫기(포기)': 배너가 닫히고 새로고침 뒤에도 다시 뜨지 않는다
    await script({ frames: [], status: 400, error: "fixture rejected request" });
    await view.getByLabel("메시지 입력").fill("또 길게");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-ended")).toBeVisible({ timeout: 15_000 });
    await expect(err.getByRole("button", { name: "새 요청 쓰기", exact: true })).toHaveCount(0);
    const input = view.getByLabel("메시지 입력");
    await input.fill("입력창에서 바로 작성");
    await expect(input).toHaveValue("입력창에서 바로 작성");
    await view.getByTestId("turn-ended").getByRole("button", { name: "닫기(포기)" }).click();
    await expect(view.getByTestId("turn-ended")).toHaveCount(0);
    await expect(input).toHaveValue("입력창에서 바로 작성");
    await page.reload();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    await expect(page.getByTestId("session-view").getByTestId("msg-user").filter({ hasText: "또 길게" })).toHaveCount(1);
    await expect(page.getByTestId("session-view").getByTestId("turn-ended")).toHaveCount(0);
    await expect(page.getByTestId("session-view").getByTestId("msg-turn-ended")).toHaveCount(2);
});

test("다시 실행은 바꾼 프로필과 모델로 원래 메시지를 보내고 작성 중인 초안을 보존한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const target = await ensureProfile();
    const title = `retry-model-${Date.now()}`;
    const original = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: title, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "original-model",
    });
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    try {
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).click();
        const view = sessionView(page, s.id);
        await composerOption(view, "모델 프로필", original.id);
        await script({ marker: title, frames: [JSON.stringify({ choices: [{ delta: { content: "중단된 응답" } }] })] });
        const input = view.getByLabel("메시지 입력");
        await input.fill(title);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        const retry = view.getByTestId("turn-ended").getByRole("button", { name: "다시 실행", exact: true });
        await expect(retry).toBeVisible({ timeout: 15_000 });
        await input.fill("보내지 않은 새 초안");
        await composerOption(view, "모델 프로필", target);
        await script({ marker: title, frames: frames.text(["바꾼 모델의 답변"]) });
        await retry.click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("바꾼 모델의 답변");
        await expect(input).toHaveValue("보내지 않은 새 초안");
        const turns = await apiCall<{ profile_id: string }[]>("GET", `/sessions/${s.id}/turns`);
        expect(turns).toHaveLength(2);
        expect(turns.some((t) => t.profile_id === target)).toBe(true);
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { model: string; messages: unknown[] }[];
        expect(requests.filter((r) => JSON.stringify(r.messages).includes(title)).map((r) => r.model)).toEqual(["original-model", "fixture-model"]);
    } finally {
        await apiCall("DELETE", `/model-profiles/${original.id}`);
    }
});

test("390px에서도 오류·복구 버튼은 입력창 폭 안에 표시된다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `모바일 오류 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await script({ frames: [JSON.stringify({ choices: [{ delta: { content: "끊기기 전 문장" } }] })] });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("중단 오류 확인");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const err = view.getByTestId("turn-ended");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expectFailureLayout(view, 390);
    await expect(err.getByTestId("turn-evidence")).toContainText("확정되지 않은 응답 · 8자");
    await expect(err.getByRole("button", { name: "다시 실행", exact: true })).toBeVisible();
    await expect(err.getByRole("button", { name: "새 요청 쓰기", exact: true })).toHaveCount(0);
    await expect(err.locator("header").getByRole("button", { name: "닫기(포기)", exact: true })).toBeVisible();
    await expect(err.locator("footer").getByRole("button", { name: "오류 상세", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("turn-error-390.png") });
    const details = err.getByTestId("msg-turn-ended");
    await openDetails(details);
    await expect(details.getByRole("dialog")).toContainText(/모델 응답 대기 한도\(설정\): \d+초/);
    await expect(details.getByRole("dialog")).not.toContainText("Codex 이벤트:");
});

// REC-009·010: 별도 확인 필요 메뉴 없이도 대화의 실패·중단 증거와 명시적 확인 절차는 유지한다.
test("끊긴 응답의 중단 증거는 다른 대화·reload 뒤에도 보존하고 대화에서 명시적으로 확인한다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `중단 증거 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    // 완료 신호 없이 연결이 끝나는 응답
    await script({ frames: [JSON.stringify({ choices: [{ delta: { content: "끊기기 전 문장" } }] })] });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("길게 써 줘");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const err = view.getByTestId("turn-ended");
    await expect(err).toBeVisible({ timeout: 15_000 });
    const evidence = err.getByTestId("turn-evidence");
    await expect(evidence).toContainText("확정되지 않은 응답 · 8자");
    await openDetails(evidence);
    await expect(evidence.locator("pre code")).toHaveText("끊기기 전 문장");
    await expect(view.getByTestId("msg-assistant")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("recovery")).toHaveCount(0);
    const recovery = () => apiCall<{ items: { session_id: string; evidence: { text_chars: number } }[] }>("GET", "/recovery");
    expect((await recovery()).items.find((item) => item.session_id === s.id)?.evidence.text_chars).toBe(8);
    // 다른 대화를 연 뒤 기존 최근 목록으로 돌아와도 경고와 원문을 잃지 않는다.
    const other = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${title} 다른` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: other.id });
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${title} 다른`) }).first().click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).filter({ hasNotText: `${title} 다른` }).first().click();
    await expect(page.getByTestId("session-view").getByTestId("turn-evidence")).toBeVisible();
    await page.reload();
    expect((await recovery()).items.some((item) => item.session_id === s.id)).toBe(true);
    await expect(page.getByTestId("session-view").getByTestId("turn-evidence")).toBeVisible();
    await page.getByTestId("session-view").getByTestId("turn-ended").getByRole("button", { name: "닫기(포기)" }).click();
    await expect(page.getByTestId("session-view").getByTestId("turn-ended")).toHaveCount(0);
    expect((await apiCall<{ items: { session_id: string }[] }>("GET", "/recovery")).items.some((item) => item.session_id === s.id)).toBe(false);
});
