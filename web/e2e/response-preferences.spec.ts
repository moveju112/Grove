import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProfile, login, script, state } from "./helpers";
import { frames } from "./fixture";

type Item = { key: string; effective: unknown; layers: { server: { value: unknown; revision: number } } };
const keys = ["output.style", "user.profile"];
let saved: { key: string; value: unknown }[] = [];

async function settings() {
    return (await apiCall<{ items: Item[] }>("GET", "/settings/effective")).items;
}

test.beforeEach(async () => {
    const items = await settings();
    saved = keys.map((key) => ({ key, value: items.find((item) => item.key === key)!.layers.server.value }));
});

test.afterEach(async () => {
    for (const item of saved) {
        const current = (await settings()).find((candidate) => candidate.key === item.key)!;
        await apiCall("PUT", `/settings/server/-/${item.key}`, { expected_revision: current.layers.server.revision, value: item.value });
    }
});

test("출력 스타일과 사용자 프로필을 저장해 다음 요청에 반영하고 새로고침 뒤에도 편집한다", async ({ page }) => {
    const profile = await ensureProfile();
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("출력 스타일");
    const style = page.getByTestId("setting-output.style");
    await style.getByLabel("출력 스타일", { exact: true }).selectOption("concise");
    await style.getByRole("button", { name: "저장", exact: true }).click();
    await expect(style).toContainText("저장됨 · 다음 요청부터 적용");
    await page.getByLabel("설정 검색").fill("사용자 프로필");
    const user = page.getByTestId("setting-user.profile");
    const background = "Fixture background: prefers concrete interface contracts.\nExamples are useful.";
    await expect(user).toContainText("모든 프로젝트의 다음 모델 요청");
    await expect(user).toContainText("지워도 이전 요청 기록은 지우지 않습니다");
    await user.getByLabel("사용자 프로필", { exact: true }).fill(background);
    await user.getByRole("button", { name: "저장", exact: true }).click();
    await expect(user).toContainText("저장됨 · 다음 요청부터 적용");
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(dirname(state().projA), "response-preferences-")) });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "response preferences fixture" });
    await script({ frames: frames.text(["fixture answer"]), marker: "fixture question" });
    const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: "fixture question", profile_id: profile });
    type Turn = { status: string; definition: { output_style: string; user_profile: { sha256: string; body?: string } } };
    await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
    const turn = await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`);
    expect(turn.definition.output_style).toBe("concise");
    expect(turn.definition.user_profile.sha256).toBe(createHash("sha256").update(background).digest("hex"));
    expect(turn.definition.user_profile.body).toBeUndefined();
    await page.reload();
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("사용자 프로필");
    await expect(page.getByTestId("setting-user.profile").getByLabel("사용자 프로필", { exact: true })).toHaveValue(background);
});

test("다른 기기의 프로필 변경과 충돌하면 내 초안을 보존하고 명시적으로 최신 값을 선택한다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("사용자 프로필");
    const user = page.getByTestId("setting-user.profile");
    await user.getByLabel("사용자 프로필", { exact: true }).fill("Fixture local draft");
    const current = (await settings()).find((item) => item.key === "user.profile")!;
    await apiCall("PUT", "/settings/server/-/user.profile", { expected_revision: current.layers.server.revision, value: "Fixture remote background" });
    await user.getByRole("button", { name: "저장", exact: true }).click();
    await expect(user).toContainText("다른 기기에서 먼저 바뀌었습니다");
    await expect(user.getByLabel("사용자 프로필", { exact: true })).toHaveValue("Fixture local draft");
    await user.getByRole("button", { name: "최신 값 사용", exact: true }).click();
    await expect(user.getByLabel("사용자 프로필", { exact: true })).toHaveValue("Fixture remote background");
    await user.getByRole("button", { name: "이 범위 값 지우기", exact: true }).click();
    const reset = page.getByRole("dialog", { name: "기본값 복원 확인", exact: true });
    await reset.getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(reset.getByRole("status").filter({ hasText: /\S/ })).toContainText("복원 저장됨");
    await reset.getByRole("button", { name: "복원 창 닫기", exact: true }).click();
    await expect(user.getByLabel("사용자 프로필", { exact: true })).toHaveValue("");
    expect((await settings()).find((item) => item.key === "user.profile")!.effective).toBe("");
});

test("너무 긴 프로필은 저장하지 않고 수정할 초안과 기존 적용값을 남긴다", async ({ page }) => {
    const before = (await settings()).find((item) => item.key === "user.profile")!.effective;
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("사용자 프로필");
    const user = page.getByTestId("setting-user.profile");
    const draft = "가".repeat(4001);
    await user.getByLabel("사용자 프로필", { exact: true }).fill(draft);
    await user.getByRole("button", { name: "저장", exact: true }).click();
    await expect(user).toContainText("저장 실패(기존 값 유지)");
    await expect(user.getByLabel("사용자 프로필", { exact: true })).toHaveValue(draft);
    expect((await settings()).find((item) => item.key === "user.profile")!.effective).toBe(before);
});

test("지침 파일 모드는 파일을 수정하지 않고 다음 요청에 선택한 파일만 전달한다", async ({ page }) => {
    const profile = await ensureProfile();
    const root = mkdtempSync(join(dirname(state().projA), "instruction-preferences-"));
    const agentText = `AGENT_INSTRUCTION_FIXTURE_${Date.now()}`;
    const claudeText = `CLAUDE_INSTRUCTION_FIXTURE_${Date.now()}`;
    writeFileSync(join(root, "AGENTS.md"), agentText);
    writeFileSync(join(root, "CLAUDE.md"), claudeText);
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "instruction preferences fixture" });
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("프로젝트 지침 파일");
    const row = page.getByTestId("setting-instructions.mode");
    await expect(row.getByRole("option", { name: "AGENTS.md만 전달", exact: true })).toHaveAttribute("value", "agents_md");
    for (const mode of ["agents_md", "claude_md", "both", "off"]) {
        await row.getByLabel("프로젝트 지침 파일", { exact: true }).selectOption(mode);
        await row.getByRole("button", { name: "저장", exact: true }).click();
        await expect(row.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨 · 다음 요청부터 적용");
        const prompt = `${project.id} instruction mode ${mode}`;
        await script({ marker: prompt, frames: frames.text(["instruction fixture complete"]) });
        const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: prompt, profile_id: profile });
        type Turn = { status: string; definition: { instructions: { file: string; sha256: string; body?: string }[] } };
        await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
        const turn = await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`);
        const expected = mode === "both" ? ["AGENTS.md", "CLAUDE.md"] : mode === "agents_md" ? ["AGENTS.md"] : mode === "claude_md" ? ["CLAUDE.md"] : [];
        expect(turn.definition.instructions.map((instruction) => instruction.file)).toEqual(expected);
        expect(turn.definition.instructions.every((instruction) => instruction.body === undefined)).toBe(true);
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { messages: { role: string; content: string }[] }[];
        const request = requests.filter((request) => JSON.stringify(request.messages).includes(prompt)).at(-1)!;
        const system = request.messages.find((message) => message.role === "system")!.content;
        expect(system.includes(agentText)).toBe(mode === "agents_md" || mode === "both");
        expect(system.includes(claudeText)).toBe(mode === "claude_md" || mode === "both");
    }
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(agentText);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(claudeText);
});
