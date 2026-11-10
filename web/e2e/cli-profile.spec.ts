import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, removeProfiles } from "./helpers";

// 서버에 설치된 CLI 백엔드(Claude Code·Codex) 프로필을 설정 화면에서 만든다. endpoint·API 키 입력이 없고 권한 제한을 안내한다.
test("설정에서 Claude Code CLI 프로필을 저가형 기본 모델로 만들 수 있고 endpoint·키 입력은 숨겨진다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("모델 프로필");
    await page.getByLabel("protocol").selectOption("claude_code");
    await expect(page.getByLabel("Base URL")).toHaveCount(0);
    await expect(page.getByLabel("API 키")).toHaveCount(0);
    await expect(page.getByLabel("모델", { exact: true })).toHaveValue("haiku");
    await expect(page.getByTestId("cli-note")).toContainText("파일 변경·명령 실행은 막습니다");
    const name = `cli-${Date.now()}`;
    try {
        await page.getByLabel("프로필 이름").fill(name);
        await page.getByRole("button", { name: "추가" }).click();
        await expect(page.locator("li").filter({ hasText: name })).toContainText("claude_code");
        const list = await apiCall<{ name: string; protocol: string; base_url: string; model: string }[]>("GET", "/model-profiles");
        const p = list.find((x) => x.name === name)!;
        expect([p.protocol, p.base_url, p.model]).toEqual(["claude_code", "", "haiku"]);
        // Codex로 바꾸면 저가형 기본 모델 gpt-6-luna
        await page.getByLabel("protocol").selectOption("codex_cli");
        await expect(page.getByLabel("모델", { exact: true })).toHaveValue("gpt-6-luna");
    } finally {
        await removeProfiles((n) => n === name);
    }
});

// 실제 CLI(opt-in): GROVE_REAL_CLI=claude_code:haiku 또는 codex_cli:gpt-6-luna
const REAL = process.env.GROVE_REAL_CLI;

test("서버에 설치된 CLI로 프로젝트 파일을 읽어 답하고 도구 활동이 표시된다(실제 CLI, opt-in)", async ({ page }) => {
    test.skip(!REAL, "실제 CLI opt-in 시험: GROVE_REAL_CLI가 없어 건너뜀");
    test.setTimeout(300_000);
    const [protocol, model] = REAL!.split(":");
    const { a } = await ensureProjects();
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { state } = await import("./helpers");
    writeFileSync(join(state().projA, "cli-note.txt"), "The secret word is PLUM-3.\n");
    const prof = await apiCall<{ id: string; name: string }>("POST", "/model-profiles", { name: `real-cli-${Date.now()}`, protocol, base_url: "", model, options: { timeout_secs: 240 } });
    // 공유 시험 서버에 남으면 다른 시험의 기본 프로필(목록 첫 항목)이 실제 CLI가 된다.
    test.info().attach("profile", { body: prof.name });
    try {
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "CLI 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /CLI 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("모델 프로필").selectOption(prof.id);
    await view.getByLabel("메시지 입력").fill("Read cli-note.txt and tell me the secret word.");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("PLUM-3", { timeout: 240_000 });
    await expect(view.getByTestId("turn-status")).toHaveCount(0, { timeout: 60_000 });
    if (protocol === "claude_code") await expect(view.getByTestId("msg-cli-activity").last()).toContainText("Read");
    } finally {
        await removeProfiles((n) => n === prof.name);
    }
});
