import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { apiCall, login, openSettings, registerBrowser, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI 인증 fixture 필요");
test.use({ trace: "retain-on-failure" });
test.beforeEach(() => writeFileSync(join(state().cliDir!, "claude-auth"), "out"));
test.afterEach(() => writeFileSync(join(state().cliDir!, "claude-auth"), "in"));

test("등록 기기가 모바일에서 공식 인증을 시작하고 재접속·취소·재로그인·로그아웃한다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    const open = async () => {
        await openSettings(page);
        await page.getByRole("searchbox", { name: "설정 검색", exact: true }).fill("모델 프로필");
        const profiles = page.locator('[data-testid="setting-profiles"]:visible');
        await profiles.getByRole("button", { name: "CLI 에이전트 연결", exact: true }).click();
        await profiles.getByRole("button", { name: "에이전트 계정 로그인", exact: true }).click();
    };
    await open();
    const codex = page.getByRole("region", { name: "Codex 계정", exact: true });
    const claude = page.getByRole("region", { name: "Claude Code 계정", exact: true });
    await expect(codex.getByRole("status").filter({ hasText: /\S/ })).toHaveText("로그인 필요");
    await codex.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(codex.getByLabel("기기 인증 코드")).toHaveText("ABCD-12345");
    await expect(codex.getByText("OpenAI 페이지에 코드 입력", { exact: true })).toBeVisible();
    const openai = codex.getByRole("link", { name: /^OpenAI 인증 페이지 열기/ });
    await expect(openai).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    await expect(openai).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(codex.getByLabel("일회용 인증 코드")).toHaveCount(0);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await codex.getByRole("button", { name: "복사", exact: true }).click();
    await expect(codex.getByText("기기 코드를 복사했어요.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("ABCD-12345");
    await codex.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("codex-login-mobile.png") });
    const attempt = await apiCall<{ attempt: { id: string } }>("GET", "/agent-backends/codex_cli/auth");
    const start = readFileSync(join(state().cliDir!, "codex-login-start"), "utf8");
    await apiCall("POST", "/agent-backends/codex_cli/login", { id: attempt.attempt.id, previous_id: null });
    expect(readFileSync(join(state().cliDir!, "codex-login-start"), "utf8")).toBe(start);
    await page.reload();
    await open();
    await expect(codex.getByLabel("기기 인증 코드")).toHaveText("ABCD-12345");
    const pid = Number(readFileSync(join(state().cliDir!, "codex-login-pid"), "utf8"));
    await codex.getByRole("button", { name: "인증 취소", exact: true }).click();
    await expect(codex.getByText("로그인 취소됨", { exact: true })).toBeVisible();
    await expect.poll(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    }).toBe(true);
    await expect(codex.getByRole("link")).toHaveCount(0);
    await codex.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(codex.getByLabel("기기 인증 코드")).toBeVisible();
    writeFileSync(join(state().cliDir!, "approve-codex"), "approve");
    await expect(codex.getByRole("status").filter({ hasText: /\S/ })).toHaveText("로그인됨");
    await claude.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(claude.getByRole("link", { name: /^Claude 인증 페이지 열기/ })).toHaveAttribute("href", "https://claude.com/cai/oauth/authorize?state=fixture");
    await expect(claude.getByText("Grove에 코드 붙여넣기", { exact: true })).toBeVisible();
    await expect(claude.getByRole("button", { name: "인증 완료", exact: true })).toBeDisabled();
    await claude.scrollIntoViewIfNeeded();
    expect(await claude.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("agent-login-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    // 모바일·PC는 별도 workspace 배치다. PC 설정을 다시 열어 같은 인증 작업을 이어 간다.
    await page.reload();
    await open();
    await claude.scrollIntoViewIfNeeded();
    expect(await claude.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("agent-login-desktop.png") });
    await claude.getByLabel("일회용 인증 코드").fill("fixture-code");
    await claude.getByRole("button", { name: "인증 완료", exact: true }).click();
    await expect(claude.getByRole("status").filter({ hasText: /\S/ })).toHaveText("로그인됨");
    await expect(claude.getByLabel("일회용 인증 코드")).toHaveCount(0);
    const data = await apiCall("GET", "/agent-backends/claude_code/auth");
    expect(JSON.stringify(data)).not.toContain("must-not-be-returned");
    expect(JSON.stringify(data)).not.toContain("fixture-code");
    page.on("dialog", (dialog) => void dialog.accept());
    await codex.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(codex.getByRole("status").filter({ hasText: /\S/ })).toHaveText("로그인 필요");
    await claude.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(claude.getByRole("status").filter({ hasText: /\S/ })).toHaveText("로그인 필요");
});

test("계정 인증 상태는 등록 기기만 읽을 수 있다", async ({ page, request }) => {
    const device = await registerBrowser(page);
    try {
        const status = "http://127.0.0.1:17741/api/v1/agent-backends/codex_cli/auth";
        expect((await request.get(status)).status()).toBe(401);
        const response = await request.get(status, { headers: { Authorization: `Bearer ${device.token}` } });
        expect(response.status()).toBe(200);
        expect(await response.text()).not.toContain("ABCD-12345");
    } finally {
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});

test("실패한 코드와 충돌한 로그인은 비밀 원문이나 새 프로세스를 남기지 않는다", async () => {
    const base = "/agent-backends/claude_code";
    const before = await apiCall<{ attempt: { id: string } | null }>("GET", `${base}/auth`);
    const id = randomUUID();
    await apiCall("POST", `${base}/login`, { id, previous_id: before.attempt?.id ?? null });
    await expect.poll(async () => (await apiCall<{ attempt: { state: string } }>("GET", `${base}/auth`)).attempt.state).toBe("waiting");
    await expect(apiCall("POST", `${base}/login`, { id: randomUUID(), previous_id: id })).rejects.toThrow("409");
    await expect(apiCall("POST", `${base}/logout`, { attempt_id: id })).rejects.toThrow("409");
    await expect(apiCall("POST", `${base}/login/cancel`, { id: randomUUID() })).rejects.toThrow("409");
    await apiCall("POST", `${base}/login/code`, { id, code: "wrong-fixture-code" });
    await expect.poll(async () => (await apiCall<{ attempt: { state: string } }>("GET", `${base}/auth`)).attempt.state).toBe("failed");
    const result = await apiCall<{ authenticated: boolean; attempt: { url: string | null; code: string | null } }>("GET", `${base}/auth`);
    expect(result.authenticated).toBe(false);
    expect(result.attempt.url).toBeNull();
    expect(result.attempt.code).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private-provider-error");
    expect(JSON.stringify(result)).not.toContain("wrong-fixture-code");
    await expect(apiCall("POST", `${base}/logout`, { attempt_id: before.attempt?.id ?? null })).rejects.toThrow("409");
});
