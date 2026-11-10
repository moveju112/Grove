import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, state } from "./helpers";

// UI-021, RUN-007·008: 실행 중에는 보내기 대신 대기열·지금 반영(steer)·중단하고 보내기를 고르고, 중지할 수 있다.
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
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("보내기 방식").selectOption("model");
    return view;
}

test("실행 중 대기열에 넣은 메시지는 끝난 뒤 새 요청으로 보내지고, 실행 중 버튼은 상태에 맞게 바뀐다", async ({ page }) => {
    const view = await openSession(page, `대기열 대화 ${Date.now()}`);
    const box = view.getByLabel("메시지 입력");
    await script({ frames: frames.text(["천천히 ", "끝나는 답"]), delayMs: 1500 });
    await script({ frames: frames.text(["대기열 답"]) });
    await expect(view.getByLabel("실행 중 보내기 방식")).toHaveCount(0);
    await box.fill("첫 질문");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    // 실행 중: 방식 선택과 버튼 이름, 중지(취소) 버튼
    await expect(view.getByLabel("실행 중 보내기 방식")).toHaveValue("queue");
    await expect(view.getByTestId("turn-status").getByRole("button", { name: "취소" })).toBeVisible();
    await box.fill("다음에 물어볼 것");
    await view.getByRole("button", { name: "대기열에 추가" }).click();
    await expect(view.getByTestId("followup")).toHaveCount(1);
    await expect(view.getByTestId("followup")).toContainText("다음에 물어볼 것");
    await expect(box).toHaveValue("");
    // 끝나면 대기열 항목이 새 요청으로
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "대기열 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("followups")).toHaveCount(0);
    await expect(view.getByTestId("msg-user")).toHaveCount(2);
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeVisible();
});

test("지금 반영(steer)은 도구 결과 뒤 다음 모델 호출에 한 번만 들어간다", async ({ page }) => {
    const view = await openSession(page, `반영 대화 ${Date.now()}`);
    const box = view.getByLabel("메시지 입력");
    const before = (await requests()).length;
    await script({ frames: frames.tool("s1", "list", {}), delayMs: 1500 });
    await script({ frames: frames.text(["반영한 답"]) });
    await view.getByLabel("도구").check();
    await box.fill("목록 보고 정리해");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    await view.getByLabel("실행 중 보내기 방식").selectOption("steer");
    await box.fill("한국어 표로 정리해");
    await view.getByRole("button", { name: "지금 반영" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "반영한 답" })).toHaveCount(1, { timeout: 15_000 });
    await view.getByLabel("도구").uncheck();
    const reqs = (await requests()).slice(before);
    expect(reqs).toHaveLength(2);
    expect(has(reqs[0]!, "한국어 표로")).toBe(false);
    expect(has(reqs[1]!, "한국어 표로")).toBe(true);
    // 대화 기록: steer는 같은 요청 안의 사용자 메시지로 한 번, 새 요청은 생기지 않음
    await expect(view.getByTestId("msg-user").filter({ hasText: "한국어 표로" })).toHaveCount(1);
    await expect(view.getByTestId("followups")).toHaveCount(0);
});

test("중단하고 보내기는 지금 실행을 취소하고 새 메시지를 바로 보낸다", async ({ page }) => {
    const view = await openSession(page, `끼어들기 대화 ${Date.now()}`);
    const box = view.getByLabel("메시지 입력");
    const before = (await requests()).length;
    await script({ frames: frames.text(["끝나지 않는 답"]).slice(0, 1), hang: true }); // 완료 프레임 없이 열어 둔다
    await script({ frames: frames.text(["새 방향 답"]) });
    await box.fill("오래 걸리는 일");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("turn-status")).toBeVisible();
    // 첫 요청이 모델에 닿은 뒤 끼어든다(대본은 도착 순서로 소비)
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    await view.getByLabel("실행 중 보내기 방식").selectOption("interrupt");
    await box.fill("방향 바꿔");
    await view.getByRole("button", { name: "중단하고 보내기" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "새 방향 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("followups")).toHaveCount(0);
    const reqs = (await requests()).slice(before);
    expect(reqs).toHaveLength(2);
    expect(has(reqs[1]!, "방향 바꿔")).toBe(true);
});

test("취소로 멈춘 대기열은 지금 시작하거나 지울 수 있다", async ({ page }) => {
    const view = await openSession(page, `멈춘 대기열 ${Date.now()}`);
    const box = view.getByLabel("메시지 입력");
    const before = (await requests()).length;
    await script({ frames: frames.text(["멈춤"]).slice(0, 1), hang: true });
    await box.fill("오래");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    for (const t of ["대기 하나", "대기 둘"]) {
        await box.fill(t);
        await view.getByRole("button", { name: "대기열에 추가" }).click();
    }
    await expect(view.getByTestId("followup")).toHaveCount(2);
    await view.getByTestId("turn-status").getByRole("button", { name: "취소" }).click();
    await expect(view.getByTestId("followups")).toContainText("멈췄습니다");
    await view.getByRole("button", { name: "대기 메시지 삭제: 대기 둘" }).click();
    await expect(view.getByTestId("followup")).toHaveCount(1);
    await script({ frames: frames.text(["하나 답"]) });
    await view.getByTestId("followup").getByRole("button", { name: "지금 시작" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "하나 답" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("followups")).toHaveCount(0);
});
