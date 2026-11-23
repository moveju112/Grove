import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView, state } from "./helpers";

type Session = { id: string; title: string; parent_session_id: string | null; fork_message_seq: number | null; fork_inherits_context: boolean };
type Message = { seq: number; role: string; content: { text?: string } };

async function requests(): Promise<{ messages: unknown[] }[]> {
    return await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { messages: unknown[] }[];
}

async function turn(sessionId: string, profile: string, text: string, answer: string) {
    await script({ frames: frames.text([answer]), marker: text });
    const { turn } = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${sessionId}/turns`, { text, profile_id: profile, tools: false });
    await expect.poll(async () => (await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${sessionId}/turns`))
        .find((t) => t.id === turn.id)?.status, { timeout: 15_000 }).toBe("completed");
}

test("응답의 '여기에서 채팅 분기'는 그 응답까지의 대화를 이어받는 새 대화를 연다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const stamp = Date.now();
    const title = `분기 원본 ${stamp}`;
    const source = await apiCall<Session>("POST", `/projects/${a.id}/sessions`, { title });
    await turn(source.id, profile, `첫 질문 ${stamp}`, `첫 답 ${stamp}`);
    await turn(source.id, profile, `둘째 질문 ${stamp}`, `둘째 답 ${stamp}`);
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: source.id });

    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, source.id);
    const first = view.getByTestId("msg-assistant").filter({ hasText: `첫 답 ${stamp}` });
    await expect(first).toBeVisible();
    await first.getByRole("button", { name: "응답 작업", exact: true }).click();
    await page.getByRole("button", { name: "여기에서 채팅 분기", exact: true }).click();

    const forks = async () => (await apiCall<{ items: Session[] }>("GET", `/projects/${a.id}/sessions?limit=200`)).items.filter((s) => s.parent_session_id === source.id);
    await expect.poll(async () => (await forks()).length).toBe(1);
    const fork = (await forks())[0]!;
    const messages = await apiCall<{ items: Message[] }>("GET", `/sessions/${source.id}/messages`);
    const firstAnswer = messages.items.find((m) => m.role === "assistant" && m.content.text?.includes(`첫 답 ${stamp}`))!;
    expect(fork.fork_message_seq).toBe(firstAnswer.seq);
    expect(fork.fork_inherits_context).toBe(true);
    const forked = sessionView(page, fork.id);
    await expect(forked).toBeVisible();
    await expect(forked).toContainText("분기된 대화 · 모델 컨텍스트 계승");

    // 새 대화의 모델 입력에는 분기 지점까지의 대화만 들어간다.
    const before = (await requests()).length;
    await turn(fork.id, profile, `분기 질문 ${stamp}`, `분기 답 ${stamp}`);
    const sent = JSON.stringify((await requests()).slice(before).find((r) => JSON.stringify(r.messages).includes(`분기 질문 ${stamp}`))!.messages);
    expect(sent).toContain(`첫 질문 ${stamp}`);
    expect(sent).toContain(`첫 답 ${stamp}`);
    expect(sent).not.toContain(`둘째 질문 ${stamp}`);
});
