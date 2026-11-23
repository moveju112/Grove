import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apiCall, composerOption, ensureProjects, login, removeProfiles, requireToolApproval, selectChoice, state } from "./helpers";

// 서버에 설치된 CLI 백엔드(Claude Code·Codex) 프로필을 설정 화면에서 만든다. endpoint·API 키 입력이 없고 권한 제한을 안내한다.
test("설정에서 Claude Code CLI 프로필을 저가형 기본 모델로 만들 수 있고 endpoint·키 입력은 숨겨진다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("모델 프로필");
    await selectChoice(page.getByLabel("protocol"), "claude_code");
    await expect(page.getByLabel("Base URL")).toHaveCount(0);
    await expect(page.getByLabel("API 키")).toHaveCount(0);
    await expect(page.getByLabel("모델", { exact: true })).toHaveValue("haiku");
    await expect(page.getByTestId("cli-note")).toContainText("서버 CLI · 프로젝트 수정·검사 가능");
    const name = `cli-${Date.now()}`;
    try {
        await page.getByLabel("프로필 이름").fill(name);
        await page.getByRole("form", { name: "모델 프로필 추가", exact: true }).getByRole("button", { name: "추가", exact: true }).click();
        await expect(page.locator("li").filter({ hasText: name })).toContainText("claude_code");
        const list = await apiCall<{ name: string; protocol: string; base_url: string; model: string }[]>("GET", "/model-profiles");
        const p = list.find((x) => x.name === name)!;
        expect([p.protocol, p.base_url, p.model]).toEqual(["claude_code", "", "haiku"]);
        await selectChoice(page.getByLabel("protocol"), "codex_cli");
        await expect(page.getByLabel("Base URL")).toHaveCount(0);
        await expect(page.getByLabel("API 키")).toHaveCount(0);
        await expect(page.getByLabel("모델", { exact: true })).toHaveValue("default");
        await page.getByLabel("프로필 이름").fill(`${name}-codex`);
        await page.getByRole("form", { name: "모델 프로필 추가", exact: true }).getByRole("button", { name: "추가", exact: true }).click();
        await expect(page.getByText(`${name}-codex`, { exact: true })).toBeVisible();
        const profiles = await apiCall<typeof list>("GET", "/model-profiles");
        expect(profiles.find((x) => x.name === `${name}-codex`)).toMatchObject({ protocol: "codex_cli", base_url: "", model: "default" });
    } finally {
        await removeProfiles((n) => n === name || n === `${name}-codex`);
    }
});

test("CLI 예약이 허용 목록, 사용자 승인, 토큰 한도를 Grove에서 적용한다", async () => {
    test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI fixture 필요");
    const { a } = await ensureProjects();
    await requireToolApproval(a.id);
    await writeFile(join(state().projA, "cli-schedule-check.txt"), "GROVE_SCHEDULE_FILE");
    for (const protocol of ["codex_cli", "claude_code"]) {
        const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
            name: `schedule-fixture-${protocol}`, protocol, base_url: "", model: "default",
        });
        try {
            for (const [action, extra, status, error] of [
                ["off", { tools: false }, "completed", undefined],
                ["read", { tools: true, allowed_tools: ["read"] }, "completed", undefined],
                ["denied", { tools: true, allowed_tools: ["read"] }, "failed", "cli_invalid_tool_plan"],
                ["write", { tools: true, allowed_tools: ["write"], on_approval: "fail" }, "failed", "approval_required"],
                ["write", { tools: true, allowed_tools: ["write"], max_total_tokens: 1 }, "failed", "budget_exceeded"],
            ] as const) {
                const schedule = await apiCall<{ id: string; revision: number }>("POST", `/projects/${a.id}/schedules`, {
                    name: `CLI 예약 ${protocol} ${action}`, prompt: `fixture-schedule-${action}`,
                    profile_id: profile.id, kind: "interval", interval_minutes: 600, ...extra,
                });
                try {
                    const run = await apiCall<{ turn_id: string }>("POST", `/schedules/${schedule.id}/run`, {});
                    expect(run.turn_id).toBeTruthy();
                    await expect.poll(async () => {
                        const turn = await apiCall<{ status: string; error?: { code: string } }>("GET", `/turns/${run.turn_id}`);
                        return [turn.status, turn.error?.code];
                    }, { timeout: 15_000 }).toEqual([status, error]);
                } finally {
                    const latest = await apiCall<typeof schedule>("GET", `/schedules/${schedule.id}`);
                    await apiCall("POST", `/schedules/${schedule.id}/delete`, { expected_revision: latest.revision });
                }
            }
        } finally {
            await apiCall("DELETE", `/model-profiles/${profile.id}`);
        }
    }
});

// 실제 CLI(opt-in): GROVE_REAL_CLI=claude_code:haiku 또는 codex_cli:gpt-6-luna
const REAL = process.env.GROVE_REAL_CLI;

test("서버에 설치된 CLI로 파일을 읽어 답하고 도구 활동을 표시한다(실제 CLI, opt-in)", async ({ page }) => {
    test.skip(!REAL, "실제 CLI opt-in 시험: GROVE_REAL_CLI가 없어 건너뜀");
    if (process.env.GROVE_E2E_FAST !== "1") test.setTimeout(300_000);
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
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /CLI 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "model");
    await composerOption(view, "모델 프로필", prof.id);
    await view.getByLabel("메시지 입력").fill("Read cli-note.txt and tell me the secret word.");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("PLUM-3", { timeout: 240_000 });
    await expect(view.getByTestId("turn-status")).toHaveCount(0, { timeout: 60_000 });
    await expect(view.getByTestId("msg-cli-activity")).toBeVisible();
    } finally {
        await removeProfiles((n) => n === prof.name);
    }
});
