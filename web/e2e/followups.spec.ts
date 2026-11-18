import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, runningSendMode, script, state } from "./helpers";

// UI-021, RUN-007·008: 실행 중에는 보내기 대신 대기열·합치기(steer)·중단 후 전송을 고르고, 중지할 수 있다.
async function requests(): Promise<{ messages: { role: string; content: unknown }[] }[]> {
    const r = await fetch(`http://127.0.0.1:${state().fixturePort}/requests`);
    return (await r.json()) as { messages: { role: string; content: unknown }[] }[];
}
const has = (req: { messages: { content: unknown }[] }, s: string) => JSON.stringify(req.messages).includes(s);

async function openSession(page: Page, title: string) {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    if (page.viewportSize()!.width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "model");
    return view;
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 합치기와 대기열`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("기본 보내기인 합치기는 같은 요청으로 이어지고 대기열은 입력창 폭을 따른다", async ({ page }, info) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const profile = await ensureProfile();
            const title = `merge-${width}-${Date.now()}`;
            const view = await openSession(page, title);
            const sid = (await view.getAttribute("data-session"))!;
            await script({ marker: title, frames: frames.text(["첫 답변"]), delayMs: 1500 });
            await script({ marker: title, frames: frames.text(["합쳐서 이어진 답변"]) });
            await script({ marker: title, frames: frames.text(["별도 대기열 답변"]) });
            const start = page.waitForResponse((response) => response.request().method() === "POST"
                && response.url().endsWith(`/sessions/${sid}/turns`));
            await view.getByLabel("메시지 입력").fill(title);
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            const initial = await (await start).json() as { turn: { id: string } };
            try {
                await expect(view.getByTestId("partial")).toContainText("첫 답변");
                await apiCall("POST", `/sessions/${sid}/followups`, {
                    kind: "queue", text: "별도로 보낼 대기 메시지 ".repeat(12), profile_id: profile, tools: false,
                });
                const added = page.waitForResponse((response) => response.request().method() === "POST"
                    && response.url().endsWith(`/sessions/${sid}/followups`));
                await view.getByLabel("메시지 입력").fill("현재 요청에 합칠 추가 지시");
                await view.getByRole("button", { name: "합치기", exact: true }).click();
                const response = await added;
                expect(response.request().postDataJSON().kind).toBe("steer");
                expect((await response.json()).followup.kind).toBe("steer");
                const panel = view.getByTestId("followups");
                await expect(panel.getByTestId("followup")).toHaveCount(2);
                await expect(panel.getByTestId("followup").last()).toContainText("합치기");
                const queue = (await panel.boundingBox())!;
                const composer = (await view.getByTestId("composer").boundingBox())!;
                expect(Math.abs(queue.width - composer.width)).toBeLessThanOrEqual(1);
                expect(Math.abs(queue.x - composer.x)).toBeLessThanOrEqual(1);
                expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
                await page.screenshot({ path: info.outputPath(`followups-${width}.png`), animations: "disabled" });
                await expect(view.getByTestId("msg-assistant").filter({ hasText: "별도 대기열 답변" })).toHaveCount(1, { timeout: 15_000 });
                await expect(panel).toHaveCount(0);
                const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${sid}/turns`);
                expect(turns).toHaveLength(2);
                expect(turns.find((turn) => turn.id === initial.turn.id)?.status).toBe("completed");
                const history = await apiCall<{ items: { role: string; turn_id: string; content: { text?: string } }[] }>("GET", `/sessions/${sid}/messages`);
                expect(history.items.filter((message) => message.content.text === "현재 요청에 합칠 추가 지시"))
                    .toEqual([expect.objectContaining({ role: "user", turn_id: initial.turn.id })]);
                expect(history.items.find((message) => message.content.text === "합쳐서 이어진 답변")?.turn_id).toBe(initial.turn.id);
            } finally {
                const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${sid}/turns`);
                for (const turn of turns.filter((turn) => ["queued", "running", "awaiting_approval"].includes(turn.status)))
                    await apiCall("POST", `/turns/${turn.id}/cancel`);
            }
        });
    });
}

test("실행 중 대기열에 넣은 메시지는 끝난 뒤 새 요청으로 보내지고, 실행 중 버튼은 상태에 맞게 바뀐다", async ({ page }) => {
    const view = await openSession(page, `대기열 대화 ${Date.now()}`);
    await runningSendMode(page, "queue");
    const box = view.getByLabel("메시지 입력");
    await script({ frames: frames.text(["천천히 ", "끝나는 답"]), delayMs: 1500 });
    await script({ frames: frames.text(["대기열 답"]) });
    await expect(view.getByLabel("실행 중 보내기 방식")).toHaveCount(0);
    await box.fill("첫 질문");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    // 방식 선택은 설정으로 옮겼고 입력창에는 현재 방식의 전송·취소 버튼만 남긴다.
    await expect(view.getByRole("combobox", { name: "실행 중 보내기 방식", exact: true })).toHaveCount(0);
    await expect(view.getByTestId("turn-status").getByRole("button", { name: "취소" })).toBeVisible();
    await box.fill("다음에 물어볼 것");
    await view.getByRole("button", { name: "대기열", exact: true }).click();
    await expect(view.getByTestId("followup")).toHaveCount(1);
    await expect(view.getByTestId("followup")).toContainText("다음에 물어볼 것");
    await expect(box).toHaveValue("");
    // 끝나면 대기열 항목이 새 요청으로
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "대기열 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("followups")).toHaveCount(0);
    await expect(view.getByTestId("msg-user")).toHaveCount(2);
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeVisible();
});

test("합치기(steer)는 도구 결과 뒤 다음 모델 호출에 한 번만 들어간다", async ({ page }) => {
    const view = await openSession(page, `반영 대화 ${Date.now()}`);
    await runningSendMode(page, "steer");
    const box = view.getByLabel("메시지 입력");
    const before = (await requests()).length;
    await script({ frames: frames.tool("s1", "list", {}), delayMs: 1500 });
    await script({ frames: frames.text(["반영한 답"]) });
    await composerOption(view, "도구", true);
    await box.fill("목록 보고 정리해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    await box.fill("한국어 표로 정리해");
    await view.getByRole("button", { name: "합치기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "반영한 답" })).toHaveCount(1, { timeout: 15_000 });
    await composerOption(view, "도구", false);
    const reqs = (await requests()).slice(before);
    expect(reqs).toHaveLength(2);
    expect(has(reqs[0]!, "한국어 표로")).toBe(false);
    expect(has(reqs[1]!, "한국어 표로")).toBe(true);
    // 대화 기록: steer는 같은 요청 안의 사용자 메시지로 한 번, 새 요청은 생기지 않음
    await expect(view.getByTestId("msg-user").filter({ hasText: "한국어 표로" })).toHaveCount(1);
    await expect(view.getByTestId("followups")).toHaveCount(0);
});

test("중단 후 전송은 지금 실행을 취소하고 새 메시지를 바로 보낸다", async ({ page }) => {
    const view = await openSession(page, `끼어들기 대화 ${Date.now()}`);
    await runningSendMode(page, "interrupt");
    const box = view.getByLabel("메시지 입력");
    const before = (await requests()).length;
    await script({ frames: frames.text(["끝나지 않는 답"]).slice(0, 1), hang: true }); // 완료 프레임 없이 열어 둔다
    await script({ frames: frames.text(["새 방향 답"]) });
    await box.fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    // 첫 요청이 모델에 닿은 뒤 끼어든다(대본은 도착 순서로 소비)
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    await box.fill("방향 바꿔");
    await view.getByRole("button", { name: "중단 후 전송", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "새 방향 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("followups")).toHaveCount(0);
    const reqs = (await requests()).slice(before);
    expect(reqs).toHaveLength(2);
    expect(has(reqs[1]!, "방향 바꿔")).toBe(true);
});

test("취소로 멈춘 대기열은 지금 시작하거나 지울 수 있다", async ({ page }) => {
    const view = await openSession(page, `멈춘 대기열 ${Date.now()}`);
    await runningSendMode(page, "queue");
    const box = view.getByLabel("메시지 입력");
    const before = (await requests()).length;
    await script({ frames: frames.text(["멈춤"]).slice(0, 1), hang: true });
    await box.fill("오래");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    for (const t of ["대기 하나", "대기 둘"]) {
        await box.fill(t);
        await view.getByRole("button", { name: "대기열", exact: true }).click();
    }
    await expect(view.getByTestId("followup")).toHaveCount(2);
    page.once("dialog", (dialog) => dialog.accept());
    await view.getByTestId("turn-status").getByRole("button", { name: "취소" }).click();
    await expect(view.getByTestId("followups")).toContainText("멈췄습니다");
    await view.getByRole("button", { name: "대기 메시지 삭제: 대기 둘" }).click();
    await expect(view.getByTestId("followup")).toHaveCount(1);
    await script({ frames: frames.text(["하나 답"]) });
    await view.getByTestId("followup").getByRole("button", { name: "지금 시작" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "하나 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("followups")).toHaveCount(0);
});
