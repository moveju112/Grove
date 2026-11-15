import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, selectChoice, sessionView, state } from "./helpers";
import { frames } from "./fixture";

test("소유 작업이 남은 final은 중간 응답으로 표시하고 작업 결과 뒤에 완료한다", async ({ page }) => {
    const profile = await ensureProfile();
    const { a } = await ensureProjects();
    const title = `owned completion ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    await composerOption(view, "보내기 방식", "model");
    await composerOption(view, "모델 프로필", profile);
    await composerOption(view, "도구", true);
    await script({ frames: frames.tool("bg", "shell", { command: "sleep 10", background: true, timeout_ms: 10000 }), marker: title });
    await script({ frames: frames.text(["아직 결과를 모르는 응답"]), marker: title });
    await script({ frames: frames.text(["작업은 취소됐고 성공으로 처리하지 않았어"]), marker: title });
    try {
        await view.getByLabel("메시지 입력").fill(title);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await view.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect(view.getByTestId("msg-completion-deferred")).toBeVisible();
        await expect(view.getByTestId("msg-assistant").last().getByTestId("msg-who")).toContainText("중간 응답");
        await expect(view.getByTestId("turn-status")).toBeVisible();
        const turns = await apiCall<{ id: string; status: string; finished_at: string | null }[]>("GET", `/sessions/${session.id}/turns`);
        expect(turns).toHaveLength(1);
        expect(turns[0]!.status).toBe("running");
        expect(turns[0]!.finished_at).toBeNull();
        const tasks = await apiCall<{ tasks: { id: string; status: string }[] }>("GET", `/sessions/${session.id}/tasks`);
        expect(tasks.tasks).toHaveLength(1);
        expect(tasks.tasks[0]!.status).toBe("running");
        await apiCall("POST", `/tasks/${tasks.tasks[0]!.id}/cancel`);
        await expect(view.getByTestId("msg-task-result")).toContainText("cancelled");
        await expect(view.getByTestId("msg-assistant").last()).toContainText("성공으로 처리하지 않았어");
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { messages: unknown[] }[];
        const last = JSON.stringify(requests.filter((request) => JSON.stringify(request.messages).includes(title)).at(-1));
        expect(last).toContain("[background task result]");
        expect(last).toContain("cancelled");
        await page.reload();
        await expect(sessionView(page, session.id).getByTestId("msg-completion-deferred")).toBeVisible();
        await expect(sessionView(page, session.id).getByTestId("msg-assistant").filter({ hasText: "아직 결과를 모르는 응답" }).getByTestId("msg-who")).toContainText("중간 응답");
    } finally {
        const tasks = await apiCall<{ tasks: { id: string; status: string }[] }>("GET", `/sessions/${session.id}/tasks`);
        for (const task of tasks.tasks.filter((task) => task.status === "running")) await apiCall("POST", `/tasks/${task.id}/cancel`);
        const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${session.id}/turns`);
        for (const turn of turns.filter((turn) => ["running", "queued", "awaiting_approval"].includes(turn.status))) await apiCall("POST", `/turns/${turn.id}/cancel`);
    }
});
