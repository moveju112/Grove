import { expect, test } from "@playwright/test";
import { audit } from "./a11y-audit";
import { apiCall, apiText, composerOption, ensureProjects, login, openProjectTerminal } from "./helpers";

// 좁은 화면: PC 분할을 강제로 복사하지 않고 단일 pane으로 보인다(FLOW-12).
test("좁은 화면은 기기별 배치를 따로 쓰고 한 pane만 보여 준다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "폰 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바" }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /폰 대화/ }).first().click();
    await expect(page.getByTestId("pane")).toHaveCount(1);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-session", s.id);
    await expect(page.getByRole("button", { name: "오른쪽으로 분할" })).toHaveCount(0);
});

// 모바일 터미널: 보조 키 막대의 Ctrl로 실행 중 명령을 중단하고, 화살표로 이전 명령을 불러온다(TERM-005).
test("모바일 터미널 보조 키로 Ctrl+C와 화살표를 보낼 수 있다", async ({ page }) => {
    const { a } = await ensureProjects();
    const t = await apiCall<{ id: string; name: string }>("POST", `/projects/${a.id}/terminals`, { name: "폰 터미널" });
    await login(page);
    await openProjectTerminal(page, a.name, t.name);
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    const keys = view.getByLabel("보조 키");
    await expect(keys).toBeVisible();
    await view.locator(".xterm").click();
    await page.keyboard.type("sleep 30; echo not-interrupted");
    await page.keyboard.press("Enter");
    await keys.getByRole("button", { name: "Ctrl" }).click();
    await expect(keys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    await view.locator(".xterm").click();
    await page.keyboard.type("c");
    await expect(keys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.type("echo after-$((2+3))");
    await page.keyboard.press("Enter");
    await expect(view.locator(".xterm-rows")).toContainText("after-5");
    // 중단되었으면 'not-interrupted'는 입력한 명령 줄에만 있고 단독 출력으로는 나오지 않는다.
    const text = await view.locator(".xterm-rows").innerText();
    expect((text.match(/not-interrupted/g) ?? []).length).toBe((text.match(/echo not-interrupted/g) ?? []).length);
    expect(text).toContain("^C");
    // ↑ 보조 키로 직전 명령을 다시 실행: 서버 scrollback 원문에서 출력 줄이 두 번 나와야 한다
    await page.keyboard.type("echo up-$((1+1))");
    await page.keyboard.press("Enter");
    // 입력한 명령 줄에는 'up-2'가 없으므로(셸이 계산) 개수가 곧 실행 횟수다.
    const runs = async () => ((await apiText(`/terminals/${t.id}/screen`)).match(/up-2/g) ?? []).length;
    await expect.poll(runs).toBe(1);
    await keys.getByRole("button", { name: "위 화살표" }).click();
    await view.locator(".xterm").click();
    await page.keyboard.press("Enter");
    await expect.poll(runs).toBe(2);
    await apiCall("POST", `/terminals/${t.id}/kill`);
});

// UI-019: 터치 키보드에서는 Enter 보내기 설정이어도 Enter가 줄바꿈이고, 보내기 버튼으로 보낸다.
test("모바일 입력창은 Enter가 줄바꿈이고 보내기 버튼으로 보낸다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "폰 입력 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.evaluate(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ enterToSend: true })));
    await page.reload();
    await page.getByRole("button", { name: "사이드바" }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /폰 입력 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "save");
    const box = view.getByLabel("메시지 입력");
    await expect(box).toHaveAttribute("enterkeyhint", "enter");
    await box.pressSequentially("한 줄");
    await box.press("Enter");
    await box.pressSequentially("두 줄");
    await expect(box).toHaveValue("한 줄\n두 줄");
    await expect(view.getByTestId("msg-user")).toHaveCount(0);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});

// UI-029: 터치 화면의 조작 요소는 24×24px 이상이고 이름이 있다.
test("모바일 주요 화면의 조작 요소는 터치 영역이 충분하고 이름이 있다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "폰 접근성 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    const problems: string[] = [];
    const check = async (where: string) => {
        const r = await audit(page, { touch: true });
        problems.push(...r.small.map((x) => `${where} 작음: ${x}`), ...r.unnamed.map((x) => `${where} 이름 없음: ${x}`), ...r.contrast.map((x) => `${where} 대비: ${x}`));
    };
    await check("대화 목록");
    await page.getByRole("button", { name: "사이드바" }).click();
    await check("사이드바");
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /폰 접근성 대화/ }).first().click();
    await check("대화");
    expect(problems, problems.join("\n")).toEqual([]);
});

test("모바일에서 첨부만 저장하고 원문을 미리본다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "폰 첨부" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("button", { name: "사이드바" }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /폰 첨부/ }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "save");
    await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name: "폰-원문.txt", mimeType: "text/plain", buffer: Buffer.from("모바일 첨부 원문") });
    await expect(view.getByTestId("attachment-card")).toContainText("폰-원문.txt");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const sent = view.getByLabel("메시지 첨부파일");
    await expect(sent).toContainText("폰-원문.txt");
    await sent.getByRole("button", { name: "미리보기", exact: true }).click();
    await expect(sent.locator("pre")).toHaveText("모바일 첨부 원문");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
