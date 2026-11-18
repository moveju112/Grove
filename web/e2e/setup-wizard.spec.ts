import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { registerBrowser, selectChoice, state } from "./helpers";

async function signIn(page: Page, url: string, token: string) {
    await registerBrowser(page, url, token);
    await page.goto(url);
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
}

test("새 데몬의 5단계, 재접속, 추가 브라우저의 로컬 전용 설정", async ({ page, browser }, info) => {
    const data = mkdtempSync(join(tmpdir(), "grove-setup-e2e-"));
    const cliDir = state().cliDir;
    const child = spawn(process.env.GROVE_BIN!, ["serve", "--json", "--listen", "127.0.0.1:0", "--data-dir", data], {
        env: { ...process.env, GROVE_WEB_DIR: join(state().work, "web"), GROVE_LOG: "off",
            ...(cliDir ? { PATH: `${cliDir}:${process.env.PATH}`, CLI_FIXTURE_DIR: cliDir } : {}) },
        stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(child, "exit");
    const read = createInterface({ input: child.stdout });
    const other = await browser.newContext();
    try {
        const [line] = await once(read, "line", { signal: AbortSignal.timeout(15_000) });
        const url = (JSON.parse(line) as { url: string }).url;
        const owner = readFileSync(join(data, "owner-token"), "utf8").trim();
        await page.setViewportSize({ width: 390, height: 844 });
        await signIn(page, url, owner);
        const wizard = page.getByTestId("setup-wizard");
        const heading = (name: string) => wizard.getByRole("heading", { name, exact: true });
        const choice = (name: string) => wizard.getByRole("combobox", { name, exact: true });
        const next = wizard.getByRole("button", { name: "다음", exact: true });
        const workspace = page.getByTestId("conn");
        await expect(heading("테마")).toBeVisible();
        await expect(workspace).toHaveCount(0);
        await expect(wizard).toContainText("로컬 설정 · 1/5");
        await selectChoice(choice("테마"), "soft");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "soft");
        await page.screenshot({ path: info.outputPath("setup-theme-390.png") });
        await next.click();
        await expect(heading("Enter로 보내기")).toBeVisible();
        const enter = choice("Enter로 보내기");
        await expect(enter).toHaveAttribute("data-selected-value", "false");
        await selectChoice(enter, "true");
        await wizard.getByRole("button", { name: "뒤로", exact: true }).click();
        await expect(choice("테마")).toHaveAttribute("data-selected-value", "soft");
        await next.click();
        await expect(enter).toHaveAttribute("data-selected-value", "true");
        await next.click();
        await expect(heading("계정 로그인")).toBeVisible();
        await page.reload();
        await expect(heading("계정 로그인")).toBeVisible();
        await expect(workspace).toHaveCount(0);
        if (cliDir) {
            for (const name of ["Claude Code", "Codex"]) {
                await expect(wizard.getByRole("region", { name: `${name} 계정`, exact: true })
                    .getByRole("button", { name: "로그인", exact: true })).toBeEnabled();
            }
        }
        await page.screenshot({ path: info.outputPath("setup-accounts-390.png") });
        await next.click(); // 계정 로그인은 선택 사항이다.
        const style = choice("출력 스타일");
        await expect(style).toHaveAttribute("data-selected-value", "default");
        await selectChoice(style, "simple");
        await next.click();
        await expect(choice("서버 PC 제어")).toHaveAttribute("data-selected-value", "false");
        await expect(workspace).toHaveCount(0);
        await wizard.getByRole("button", { name: "설정 완료", exact: true }).click();
        await expect(workspace).toHaveText("연결됨");
        await page.reload();
        await expect(workspace).toHaveText("연결됨");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "soft");
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.device.prefs")!).enterToSend)).toBe(true);

        const second = await other.newPage();
        await signIn(second, url, owner);
        const local = second.getByTestId("setup-wizard");
        await expect(local).toContainText("로컬 설정 · 1/2");
        await local.getByRole("button", { name: "다음", exact: true }).click();
        await local.getByRole("button", { name: "설정 완료", exact: true }).click();
        await expect(second.getByTestId("conn")).toHaveText("연결됨");
        const response = await fetch(`${url}api/v1/settings/effective`, { headers: { authorization: `Bearer ${owner}` } });
        const { items } = await response.json() as { items: { key: string; effective: unknown }[] };
        expect(items.find(({ key }) => key === "output.style")?.effective).toBe("simple");
        expect(items.find(({ key }) => key === "computer.enabled")?.effective).toBe(false);
    } finally {
        await other.close();
        child.kill();
        await exited;
        read.close();
        rmSync(data, { recursive: true, force: true });
    }
});
