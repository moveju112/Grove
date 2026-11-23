import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, openProjectSettings, registerBrowser, state } from "./helpers";

const roots: string[] = [];
test.afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

async function project() {
    const root = mkdtempSync(join(state().projA, "source-settings-"));
    roots.push(root);
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, ".codex"));
    const original = JSON.stringify({
        autoMemoryEnabled: true, cleanupPeriodDays: 13,
        env: { FIXTURE: "source-private-marker" },
        hooks: { PreToolUse: [{ matcher: "Bash|Read", hooks: [{
            type: "command", command: `touch '${join(root, "must-not-exist")}' source-private-marker`,
        }] }] },
    });
    writeFileSync(join(root, ".claude/settings.json"), original);
    mkdirSync(join(root, ".claude/skills/review"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/review/SKILL.md"), "---\nname: source-review\ndescription: Read-only source review\n---\nsource-private-marker body\n");
    mkdirSync(join(root, ".agents/skills/codex-review"), { recursive: true });
    writeFileSync(join(root, ".agents/skills/codex-review/SKILL.md"), "---\nname: codex-review\ndescription: Codex source review\n---\nsource-private-marker body\n");
    writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "source-private-marker" }] }] },
    }));
    writeFileSync(join(root, ".codex/config.toml"), 'private = "source-private-marker"');
    const item = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    return { ...item, root, original };
}

test("프로젝트 설정은 기본으로 접고 실제 인증 API에서 안전한 원본 정보만 표시한다", async ({ page }, testInfo) => {
    const item = await project();
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByTestId("project-row").getByRole("button", { name: item.name, exact: true }).click();
    await openProjectSettings(page);
    await page.getByLabel("설정 검색", { exact: true }).fill("원본");
    const panel = page.getByTestId("source-settings");
    await expect(panel.getByRole("button", { name: "원본 설정 보기", exact: true })).toHaveCount(0);
    const source = panel.getByRole("region", { name: "Claude · 프로젝트 원본", exact: true });
    await expect(panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("source-settings-mobile.png") });
    await expect(source).toContainText("13일");
    const skill = source.getByRole("button", { name: "source-review", exact: true });
    await expect(source.getByText("Read-only source review", { exact: true })).toBeHidden();
    await skill.focus();
    await page.keyboard.press("Enter");
    const detail = source.getByRole("dialog", { name: "source-review 스킬", exact: true });
    await expect(detail.getByText("Read-only source review", { exact: true })).toBeVisible();
    await expect(detail).toContainText(".claude/skills/review/SKILL.md");
    await expect(detail).not.toContainText("source-private-marker");
    await page.keyboard.press("Escape");
    await expect(skill).toBeFocused();
    await expect(source.getByText("PreToolUse", { exact: true })).toBeHidden();
    const hooks = source.getByRole("button", { name: "자동 실행 1개", exact: true });
    await hooks.click();
    const hookDetail = source.getByRole("dialog", { name: "자동 실행 상세", exact: true });
    await expect(hookDetail).toContainText("PreToolUse");
    await expect(hookDetail).toContainText("Bash|Read");
    await expect(hookDetail).toContainText("명령 있음");
    await page.keyboard.press("Escape");
    await expect(hooks).toBeFocused();
    const codex = panel.getByRole("region", { name: "Codex · 프로젝트 원본", exact: true });
    await codex.getByRole("button", { name: "codex-review", exact: true }).click();
    await expect(codex.getByRole("dialog")).toContainText("Codex source review");
    await page.keyboard.press("Escape");
    await expect(codex.getByText("Stop", { exact: true })).toBeHidden();
    await expect(codex.getByRole("button", { name: "자동 실행 1개", exact: true })).toBeVisible();
    await expect(panel).toContainText("읽기 전용 · Grove 적용값 아님");
    await expect(panel).not.toContainText("Grove 실제 적용 설정은");
    await expect(panel).toContainText("미지원 형식(TOML)");
    await expect(panel).not.toContainText("source-private-marker");
    await expect(panel).not.toContainText(item.root);
    await expect(panel.locator("input, textarea, select")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /저장|적용|^실행$/, exact: false })).toHaveCount(0);
    expect(readFileSync(join(item.root, ".claude/settings.json"), "utf8")).toBe(item.original);
    expect(existsSync(join(item.root, "must-not-exist"))).toBe(false);

    writeFileSync(join(item.root, ".claude/settings.json"), "source-private-marker malformed");
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(source.getByRole("alert")).toHaveCount(2);
    await expect(source).toContainText("올바른 JSON이 아니어서");
    await expect(panel).not.toContainText("source-private-marker");
    writeFileSync(join(item.root, ".claude/settings.json"), '{"cleanupPeriodDays":17}');
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(source).toContainText("17일");
});

test("원본 API는 등록 기기에 열리고 임의 root와 미등록 프로젝트는 거부한다", async ({ request, page }) => {
    const a = await project();
    const b = await project();
    const base = "http://127.0.0.1:17741/api/v1";
    const device = await registerBrowser(page);
    const owner = { authorization: `Bearer ${device.token}` };
    try {
        for (const suffix of ["", `?project_id=${a.id}`, `?project_id=${b.id}`]) {
            expect((await request.get(`${base}/source-settings${suffix}`)).status()).toBe(401);
            expect((await request.get(`${base}/source-settings${suffix}`, {
                headers: { authorization: `Bearer ${device.token}` },
            })).status()).toBe(200);
        }
        const response = await request.get(`${base}/source-settings?project_id=${a.id}&root=source-private-marker`, { headers: owner });
        expect(response.status()).toBe(400);
        expect(await response.text()).not.toContain("source-private-marker");
        const unknown = await request.get(`${base}/source-settings?project_id=unregistered`, { headers: owner });
        expect(unknown.status()).toBe(404);
        const safe = await request.get(`${base}/source-settings?project_id=${a.id}`, { headers: owner });
        expect(safe.status()).toBe(200);
        const data = await safe.json();
        expect(data.items).toEqual([
            { source: "claude_project", status: "present", projection: { autoMemoryEnabled: true, cleanupPeriodDays: 13 }, ignored_invalid_fields: false },
            { source: "claude_project_local", status: "missing" },
            { source: "codex_project", status: "unsupported_format", format: "toml" },
        ]);
        expect(data.resources).toEqual(expect.arrayContaining([
            {
                source: "claude_project", kind: "skills", relative_path: ".claude/skills",
                result: { status: "present", ignored_invalid_entries: false, entries: [{
                    name: "source-review", description: "Read-only source review", relative_path: ".claude/skills/review/SKILL.md",
                }] },
            },
            {
                source: "codex_project", kind: "hooks", relative_path: ".codex/hooks.json",
                result: { status: "present", ignored_invalid_entries: false, entries: [{ event: "Stop", matcher: null, has_command: true }] },
            },
        ]));
        expect(JSON.stringify(data)).not.toContain("source-private-marker");
        expect(JSON.stringify(data)).not.toContain(a.root);
    } finally {
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});

test("리소스 형식 오류와 symlink는 원문 없이 표시하고 재조회로 복구한다", async ({ page }) => {
    const item = await project();
    writeFileSync(join(item.root, ".claude/skills/review/SKILL.md"), "---\nname: source-review\ndescription: [source-private-marker]\n---\nsource-private-marker");
    symlinkSync("review", join(item.root, ".claude/skills/alias"));
    symlinkSync(join(item.root, ".agents/skills/codex-review"), join(item.root, ".claude/skills/escape"));
    writeFileSync(join(item.root, ".codex/hooks.json"), "source-private-marker malformed");
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: item.name, exact: true }).click();
    await openProjectSettings(page);
    await page.getByLabel("설정 검색", { exact: true }).fill("원본");
    const panel = page.getByTestId("source-settings");
    const source = panel.getByRole("region", { name: "Claude · 프로젝트 원본", exact: true });
    const codex = panel.getByRole("region", { name: "Codex · 프로젝트 원본", exact: true });
    await expect(source).toContainText("일부 항목은 형식");
    await expect(source).not.toContainText("Codex source review");
    await expect(codex.getByRole("alert")).toContainText("올바른 JSON이 아니어서");
    await expect(panel).not.toContainText("source-private-marker");
    writeFileSync(join(item.root, ".codex/hooks.json"), '{"hooks":{"Stop":[{"matcher":"API_KEY=source-private-marker","hooks":[{"type":"command","command":"source-private-marker"}]}]}}');
    writeFileSync(join(item.root, ".claude/skills/review/SKILL.md"), "---\nname: Recovered review\ndescription: 'API_KEY=source-private-marker'\n---\nsource-private-marker");
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(source).toContainText("Recovered review");
    await source.getByRole("button", { name: "Recovered review", exact: true }).click();
    const detail = source.getByRole("dialog", { name: "Recovered review 스킬", exact: true });
    await expect(detail).toContainText("[redacted]");
    await expect(detail).not.toContainText("source-private-marker");
    await page.keyboard.press("Escape");
    await expect(codex.getByRole("alert")).toHaveCount(0);
    await codex.getByRole("button", { name: "자동 실행 1개", exact: true }).click();
    const hookDetail = codex.getByRole("dialog", { name: "자동 실행 상세", exact: true });
    await expect(hookDetail).toContainText("명령 있음");
    await expect(hookDetail).toContainText("[redacted]");
    await page.keyboard.press("Escape");
    await expect(panel).not.toContainText("source-private-marker");
});

test("조회 실패 화면은 서버 오류 본문을 숨기고 다시 조회할 수 있다", async ({ page }) => {
    const item = await project();
    await page.route("**/api/v1/source-settings?*", (route) => route.fulfill({
        status: 500, contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "source-private-marker" } }),
    }));
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: item.name, exact: true }).click();
    await openProjectSettings(page);
    await page.getByLabel("설정 검색", { exact: true }).fill("원본");
    const panel = page.getByTestId("source-settings");
    await expect(panel.getByRole("alert")).toContainText("원본 출처 목록을 가져오지 못했습니다");
    await expect(panel).not.toContainText("source-private-marker");
    await page.unroute("**/api/v1/source-settings?*");
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(panel).toContainText("13일");
});
