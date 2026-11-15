import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, selectChoice } from "./helpers";

const notes = (page: Page) => page.evaluate(() => (window as unknown as { __notes: { title: string; opts: { tag: string; body: string } }[] }).__notes.map((n) => ({ title: n.title, tag: n.opts.tag, body: n.opts.body })));
const setHidden = (page: Page, hidden: boolean) => page.evaluate((h) => { (window as unknown as { __hidden: boolean }).__hidden = h; }, hidden);

test("화면을 보지 않을 때 켠 종류만 내용 없이 한 번 알리고, 알림을 누르면 그 대화를 연다", async ({ page }) => {
    await page.addInitScript(() => {
        const w = window as unknown as { __notes: unknown[]; __hidden: boolean; Notification: unknown };
        w.__notes = [];
        w.__hidden = false;
        Object.defineProperty(document, "visibilityState", { get: () => (w.__hidden ? "hidden" : "visible") });
        document.hasFocus = () => !w.__hidden;
        class FakeNotification {
            static permission = "granted";
            static requestPermission = async () => "granted";
            onclick: (() => void) | null = null;
            constructor(public title: string, public opts: unknown) { w.__notes.push(this); }
            close() {}
        }
        w.Notification = FakeNotification;
    });
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `알림 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);

    await page.getByRole("button", { name: "설정", exact: true }).first().click();
    await page.getByLabel("설정 검색", { exact: true }).fill("알림");
    const section = page.getByTestId("setting-notify");
    await selectChoice(section.getByLabel("작업 완료·실패"), "true");
    await selectChoice(section.getByLabel("승인 요청"), "true");
    await expect(section.getByTestId("notify-permission")).toContainText("허용됨");
    await expect(section.getByRole("combobox", { name: "예약·업데이트 알림", exact: true })).toHaveAttribute("data-selected-value", "false");

    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.locator(`[data-testid=session-view][data-session="${s.id}"]`);
    await script({ frames: frames.tool("n1", "write", { path: "attention.txt", content: "x" }) });
    await script({ frames: frames.text(["거부 확인"]) });
    await composerOption(view, "도구", true);
    await view.getByLabel("메시지 입력").fill("비밀 내용으로 파일 만들어");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await setHidden(page, true);
    await expect(view.getByTestId("approval")).toContainText("attention.txt", { timeout: 15_000 });
    await expect.poll(() => notes(page)).toEqual([{ title: "승인 요청", tag: expect.stringMatching(/^approval:/), body: "대화에서 도구 실행 승인을 기다립니다." }]);

    // 알림을 누르면 닫았던 대화를 다시 연다.
    await page.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(view).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __notes: { onclick: () => void }[] }).__notes[0]!.onclick());
    await expect(view).toBeVisible();

    await view.getByTestId("approval").getByRole("button", { name: "거부" }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("거부 확인", { timeout: 15_000 });
    await expect.poll(async () => (await notes(page)).map((n) => n.title)).toEqual(["승인 요청", "작업 완료"]);
    expect(JSON.stringify(await notes(page))).not.toContain("비밀");

    // 화면을 보고 있으면 알리지 않는다.
    await setHidden(page, false);
    await script({ frames: frames.text(["보는 중"]) });
    await composerOption(view, "도구", false);
    await view.getByLabel("메시지 입력").fill("다시");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("보는 중", { timeout: 15_000 });
    expect(await notes(page)).toHaveLength(2);
});
