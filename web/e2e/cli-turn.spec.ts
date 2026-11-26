import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "../app/api/generated";
import { apiCall, ensureProjects, login, openTool, sessionView, state } from "./helpers";

test("CLI 활동 목록 없이 Codex 질문에 답하고 파일을 복구한 뒤 같은 프로세스에서 이어간다", async ({ page }) => {
    test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI fixture 필요");
    await ensureProjects();
    const root = await mkdtemp(join(state().projA, "cli-turn-"));
    const original = join(root, "snapshot-edit.txt");
    const created = join(root, "snapshot-new.txt");
    await writeFile(original, "사용자 기존 수정\n");
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "CLI 턴 fixture", protocol: "codex_cli", base_url: "", model: "default",
    });
    const title = "CLI 턴 검증";
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
    const sessionApi = `/sessions/${session.id}`;
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ progressVisibility: "collapse" })));
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
    const view = sessionView(page, session.id);
    const pid = () => readFile(join(state().cliDir!, "last-pid"), "utf8");
    const start = (text: string) => apiCall("POST", `${sessionApi}/turns`, { profile_id: profile.id, text, tools: false });
    await start("fixture-native-question");
    const question = view.getByTestId("question").filter({ hasText: "수정을 적용할까요?" });
    await expect(question).toBeVisible();
    await expect(view.getByTestId("partial")).toBeVisible();
    await expect(view).not.toContainText(/도구 활동|fixture raw command/);
    await question.getByRole("button", { name: "적용", exact: true }).click();
    const extra = view.getByTestId("question").filter({ hasText: "메모를 추가할까요?" });
    await extra.getByRole("button", { name: "답하지 않고 닫기" }).click();
    const answer = view.getByTestId("msg-assistant").last();
    await expect(answer).toContainText("질문 답변 확인");
    const firstPid = await pid();
    await expect(answer).not.toContainText("도구 활동");

    const changes = await apiCall<FileChange[]>("GET", `${sessionApi}/file-changes`);
    expect(changes.map(({ path, op }) => [path, op])).toEqual([
        ["snapshot-edit.txt", "modified"], ["snapshot-new.txt", "created"],
    ]);
    await openTool(view, "변경");
    const panel = view.getByTestId("changes-panel");
    await expect(panel.getByTestId("change-row")).toHaveCount(2);
    const undo = panel.getByRole("button", { name: "이 요청의 변경 되돌리기", exact: true });
    const confirmation = () => {
        const result = page.waitForEvent("dialog").then(async (dialog) => {
            const message = dialog.message();
            await dialog.accept();
            return message;
        });
        return result;
    };
    const undoConfirmation = confirmation();
    await undo.click();
    expect(await undoConfirmation).toContain("다른 프로그램의 수정도 포함될 수 있습니다.");
    await expect(panel.locator('[data-testid="change-row"][data-state="undone"]')).toHaveCount(2);
    expect(await readFile(original, "utf8")).toBe("사용자 기존 수정\n");
    await expect(stat(created)).rejects.toMatchObject({ code: "ENOENT" });
    const redoConfirmation = confirmation();
    await panel.getByRole("button", { name: "다시 적용", exact: true }).first().click();
    expect(await redoConfirmation).toContain("다른 프로그램의 수정도 포함될 수 있습니다.");
    await expect(panel.locator('[data-testid="change-row"][data-state="applied"]')).toHaveCount(2);
    expect(await readFile(original, "utf8")).toBe("CLI 수정\n");
    if (process.platform !== "win32") expect((await stat(created)).mode & 0o111).toBe(0o111);

    await start("fixture-native-next");
    await expect(answer).toContainText("에이전트 답변 2");
    expect(await pid()).toBe(firstPid);

    const current = await apiCall<{ revision: number }>("GET", sessionApi);
    await apiCall("PATCH", sessionApi, { expected_revision: current.revision, archived: true });
    await apiCall("DELETE", `/model-profiles/${profile.id}`);
});

test("Codex 비동기 질문을 질문 창으로 받고 답을 같은 프로세스의 다음 Codex 턴으로 보낸다", async ({ page }) => {
    test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI fixture 필요");
    await ensureProjects();
    const root = await mkdtemp(join(state().projA, "cli-async-question-"));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: "CLI 비동기 질문 fixture", protocol: "codex_cli", base_url: "", model: "default",
    });
    const title = "CLI 비동기 질문";
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
    const sessionApi = `/sessions/${session.id}`;
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
    const view = sessionView(page, session.id);
    const requests = async () => (await readFile(join(state().cliDir!, "app-server-requests.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: { input?: { text?: string }[] } });
    const before = (await requests().catch(() => [])).length;
    await apiCall("POST", `${sessionApi}/turns`, { profile_id: profile.id, text: "fixture-async-question", tools: false });
    const question = view.getByTestId("question").filter({ hasText: "배포할까?" });
    await expect(question).toBeVisible();
    // 질문과 선택지는 질문 창에만 보이고 본문 목록으로 반복하지 않는다.
    await expect(view.getByText("배포할까?")).toHaveCount(1);
    await question.getByRole("button", { name: "지금 배포", exact: true }).click();
    const answer = view.getByTestId("msg-assistant").last();
    await expect(answer).toContainText("비동기 답 확인 - 배포할까?: 지금 배포");
    const turns = (await requests()).slice(before).filter((request) => request.method === "turn/start");
    expect(turns.map((request) => request.params?.input?.[0]?.text)).toEqual([
        expect.stringContaining("fixture-async-question"), "Reply to your request_user_input_async question:\n- 배포할까?: 지금 배포",
    ]);

    const current = await apiCall<{ revision: number }>("GET", sessionApi);
    await apiCall("PATCH", sessionApi, { expected_revision: current.revision, archived: true });
    await apiCall("DELETE", `/model-profiles/${profile.id}`);
});
