import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "../app/api/generated";
import { apiCall, ensureProjects, login, openDetails, openTool, selectChoice, sessionView, state } from "./helpers";

test("Codex 질문에 답하고 CLI 활동과 파일 복구를 확인한 뒤 같은 프로세스에서 이어간다", async ({ page }) => {
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
    const live = view.getByTestId("partial-cli-activity");
    await expect(live).toContainText("실행 중");
    await expect(live).not.toContainText("fixture raw command");
    const question = view.getByTestId("question").filter({ hasText: "수정을 적용할까요?" });
    await selectChoice(question.getByLabel("답변 선택"), "적용");
    await question.getByRole("button", { name: "답하기", exact: true }).click();
    const extra = view.getByTestId("question").filter({ hasText: "메모를 추가할까요?" });
    await extra.getByRole("button", { name: "답하지 않고 닫기" }).click();
    const answer = view.getByTestId("msg-assistant").last();
    await expect(answer).toContainText("질문 답변 확인");
    const firstPid = await pid();
    const activity = answer.getByTestId("msg-cli-activity");
    await openDetails(activity);
    await expect(activity.getByRole("dialog")).toContainText("완료");
    await page.keyboard.press("Escape");

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
