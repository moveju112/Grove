import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView, state } from "./helpers";

// UI-016, RUN-013·014: 모델 질문 카드(단일·복수 선택·직접 입력·닫기), 승인 대기와 구분된 상태 표시.
async function requests(): Promise<{ messages: { role: string; content: unknown }[] }[]> {
    return (await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json()) as { messages: { role: string; content: unknown }[] }[];
}
const toolText = (r: { messages: { role: string; content: unknown }[] }) => JSON.stringify(r.messages.filter((m) => m.role === "tool"));

async function askInNewSession(page: Page, args: Record<string, unknown>) {
    const { a } = await ensureProjects();
    const profileId = await ensureProfile();
    const title = `질문 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    if (page.viewportSize()!.width <= 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, s.id);
    await script({ frames: frames.tool("ask1", "ask_user", args) });
    await apiCall("POST", `/sessions/${s.id}/turns`, { profile_id: profileId, tools: true, text: "필요하면 물어보고 진행해" });
    await expect(view.getByTestId("question")).toBeVisible({ timeout: 15_000 });
    return view;
}

test("단일 선택 질문: 답변 대기로 표시되고, 고른 답으로 이어서 진행한다", async ({ page }) => {
    const view = await askInNewSession(page, {
        question: "어느 DB를 쓸까요?",
        options: [{ label: "SQLite", description: "단일 파일" }, { label: "Postgres" }],
        allow_free_text: false,
    });
    const before = (await requests()).length;
    const card = view.getByTestId("question");
    await expect(card).toContainText("어느 DB를 쓸까요?");
    const sqlite = card.getByRole("button", { name: "SQLite", exact: true });
    await expect(sqlite).toHaveAccessibleDescription("단일 파일");
    await expect(view.getByTestId("turn-status")).toContainText("답변을 기다리는 중");
    await expect(view.getByTestId("approval")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "최근", exact: true }).getByText("답변 대기").first()).toBeVisible();
    const recent = page.getByRole("region", { name: "최근", exact: true });
    const sessionId = await view.getAttribute("data-session");
    const waiting = recent.getByTestId("recent-item").and(page.locator(`[data-session="${sessionId}"]`));
    await expect(waiting).toHaveCount(1);
    await expect(waiting.getByText("답변 대기", { exact: true })).toBeVisible();
    await expect(card.getByLabel("직접 입력")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "답하기", exact: true })).toHaveCount(0);
    await sqlite.press("ArrowDown");
    const postgres = card.getByRole("button", { name: "Postgres", exact: true });
    await expect(postgres).toBeFocused();
    await script({ frames: frames.text(["Postgres로 진행"]) });
    await postgres.press("Enter");
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "Postgres로 진행" })).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("question")).toHaveCount(0);
    await expect(waiting.getByText("답변 대기", { exact: true })).toHaveCount(0);
    const r = (await requests()).slice(before);
    expect(r).toHaveLength(1);
    expect(toolText(r[0]!)).toContain("Postgres");
});

test("복수 선택과 직접 입력을 함께 보내고, 닫기는 답하지 않았음을 모델에 알린다", async ({ page }) => {
    const view = await askInNewSession(page, { question: "무엇을 포함할까요?", options: [{ label: "테스트" }, { label: "문서" }, { label: "CI" }], multi_select: true });
    const card = view.getByTestId("question");
    await expect(card).toContainText("여러 개 선택 가능");
    await card.getByRole("button", { name: "테스트", exact: true }).click();
    await card.getByRole("button", { name: "테스트", exact: true }).press("3");
    await expect(card.getByRole("button", { name: "CI", exact: true })).toHaveAttribute("aria-pressed", "true");
    await card.getByRole("button", { name: "직접 입력" }).click();
    await card.getByLabel("직접 입력").fill("CI는 ARM도");
    let before = (await requests()).length;
    // 이어지는 모델 응답: 다시 질문 → 이번에는 닫는다
    await script({ frames: frames.tool("ask2", "ask_user", { question: "지금 배포할까요?" }) });
    await card.getByRole("button", { name: "답하기" }).click();
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    const r1 = (await requests()).slice(before);
    expect(toolText(r1[0]!)).toContain("테스트");
    expect(toolText(r1[0]!)).toContain("CI는 ARM도");
    const card2 = view.getByTestId("question");
    await expect(card2).toContainText("지금 배포할까요?");
    await expect(card2).toContainText("직접 입력");
    before = (await requests()).length;
    await script({ frames: frames.text(["배포하지 않을게"]) });
    await card2.getByRole("button", { name: "답하지 않고 닫기" }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "배포하지 않을게" })).toHaveCount(1, { timeout: 15_000 });
    const r2 = (await requests()).slice(before);
    expect(toolText(r2[0]!)).toContain("답하지 않고");
});

test("모바일 번호 목록에서 직접 쓴 답변을 전송한다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const view = await askInNewSession(page, { question: "어디에서 답할까요?", options: [{ label: "대화 안에서" }, { label: "입력창 위에서" }] });
    const card = view.getByTestId("question");
    await expect(card.getByRole("button", { name: "대화 안에서" })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("question-390.png") });
    await card.getByRole("button", { name: "직접 입력" }).click();
    await card.getByRole("textbox", { name: "직접 입력" }).fill("두 곳 모두");
    const before = (await requests()).length;
    await script({ frames: frames.text(["답변을 받았어요"]) });
    await card.getByRole("button", { name: "답하기", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await requests()).slice(before).some((r) => toolText(r).includes("두 곳 모두"))).toBe(true);
});
