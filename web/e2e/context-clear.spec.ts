import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

async function profile(name: string) {
    return apiCall<{ id: string; revision: number; options: Record<string, unknown> }>("POST", "/model-profiles", {
        name, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
    });
}

test("idle context 초기화는 다음 요청만 바꾸고 화면 이력·파일을 남기며 새로고침 뒤에도 경계를 보인다", async ({ page }) => {
    const name = `context clear ${Date.now()}`;
    const model = await profile(name);
    const root = mkdtempSync(join(dirname(state().projA), "context-clear-"));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: name });
    const file = join(root, "keep.txt");
    writeFileSync(file, "user file fixture");
    await script({ frames: frames.text(["OLD_ANSWER_CONTEXT_FIXTURE"]), marker: "OLD_QUESTION_CONTEXT_FIXTURE" });
    const first = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: "OLD_QUESTION_CONTEXT_FIXTURE", profile_id: model.id });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${first.turn.id}`)).status).toBe("completed");
    await apiCall("PUT", `/settings/project/${project.id}/context.auto_clear_minutes`, { expected_revision: 0, value: 1 });
    // 시험 소유 DB의 이 대화 시각만 이동한다. 실제 1분 대기 대신 동일한 idle 입력을 만든다.
    execFileSync("python3", ["-c", `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("UPDATE messages SET created_at='2020-01-01T00:00:00Z' WHERE session_id=?",(sys.argv[2],))
c.execute("UPDATE turns SET finished_at='2020-01-01T00:00:00Z' WHERE session_id=?",(sys.argv[2],))
c.commit()
c.close()
`, join(dirname(state().projA), "data", "grove.db"), session.id]);
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
    const view = sessionView(page, session.id);
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("모델 프로필").selectOption(model.id);
    await view.getByLabel("메시지 입력").fill("NEW_CONTEXT_QUESTION_FIXTURE");
    await script({ frames: frames.text(["NEW_CONTEXT_ANSWER_FIXTURE"]), marker: "NEW_CONTEXT_QUESTION_FIXTURE" });
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("NEW_CONTEXT_ANSWER_FIXTURE");
    await expect(view.getByTestId("msg-context-clear")).toContainText("화면 이력·파일은 남아");
    await expect(view.getByTestId("msg-context-clear")).toContainText("요약 없이");
    await expect(view.getByTestId("msg-assistant").first()).toContainText("OLD_ANSWER_CONTEXT_FIXTURE");
    await expect(view.getByTestId("context-cleared")).toBeVisible();
    const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { messages: { content: string }[] }[];
    const sent = [...requests].reverse().find((r) => r.messages.some((m) => m.content.includes("NEW_CONTEXT_QUESTION_FIXTURE")))!;
    expect(JSON.stringify(sent)).not.toContain("OLD_QUESTION_CONTEXT_FIXTURE");
    expect(JSON.stringify(sent)).not.toContain("OLD_ANSWER_CONTEXT_FIXTURE");
    expect(readFileSync(file, "utf8")).toBe("user file fixture");
    await page.reload();
    await expect(sessionView(page, session.id).getByTestId("msg-context-clear")).toHaveCount(1);
    await expect(sessionView(page, session.id).getByTestId("msg-assistant").first()).toContainText("OLD_ANSWER_CONTEXT_FIXTURE");
    await apiCall("DELETE", `/model-profiles/${model.id}`);
});

test("프로필 context override는 상속·0을 구분하고 동시 변경 충돌에서 초안을 보존한다", async ({ page }) => {
    const name = `context override ${Date.now()}`;
    const model = await profile(name);
    try {
        await login(page);
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: name }).getByTestId("profile-context-policy");
        await expect(row).toContainText("범위별 설정 상속");
        await row.getByRole("button", { name: "context 정책 설정", exact: true }).click();
        await row.getByLabel("프로필 idle context 초기화(분)").fill("0");
        await row.getByRole("button", { name: "context 정책 저장", exact: true }).click();
        await expect(row).toContainText("시간 제한 없이 유지");
        await row.getByRole("button", { name: "context 정책 설정", exact: true }).click();
        await row.getByLabel("프로필 idle context 초기화(분)").fill("30");
        const latest = (await apiCall<{ id: string; revision: number }[]>("GET", "/model-profiles")).find((p) => p.id === model.id)!;
        await apiCall("PUT", `/model-profiles/${model.id}`, { expected_revision: latest.revision, options: { auto_clear_minutes: 60 } });
        await expect(row).toContainText("편집 중 프로필이 변경됐습니다");
        await row.getByRole("button", { name: "context 정책 저장", exact: true }).click();
        await expect(row.getByRole("alert")).toBeVisible();
        await expect(row.getByLabel("프로필 idle context 초기화(분)")).toHaveValue("30");
        await row.getByRole("button", { name: "현재 서버 값 불러오기", exact: true }).click();
        await expect(row.getByLabel("프로필 idle context 초기화(분)")).toHaveValue("60");
        await row.getByLabel("프로필 idle context 초기화(분)").fill("");
        await row.getByRole("button", { name: "context 정책 저장", exact: true }).click();
        await expect(row).toContainText("범위별 설정 상속");
        const stored = (await apiCall<{ id: string; options: Record<string, unknown> }[]>("GET", "/model-profiles")).find((p) => p.id === model.id)!;
        expect(stored.options.auto_clear_minutes).toBeUndefined();
    } finally {
        await apiCall("DELETE", `/model-profiles/${model.id}`);
    }
});
