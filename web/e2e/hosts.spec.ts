import { expect, test as base, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishSetup, apiCall, ensureProjects, login, openSettings, registerBrowser } from "./helpers";

type Remote = { origin: string; token: string; projectId: string };
const test = base.extend<{}, { remote: Remote }>({
    remote: [async ({}, use) => {
        const work = mkdtempSync(join(tmpdir(), "grove-hosts-"));
        const data = join(work, "data");
        const root = new URL("../..", import.meta.url).pathname;
        const origin = "http://127.0.0.1:17743";
        const child = spawn(process.env.GROVE_BIN!, ["serve", "--listen", "127.0.0.1:17743", "--data-dir", data], {
            env: { ...process.env, GROVE_WEB_DIR: join(root, "web/build/client"), GROVE_LOG: "warn" },
            stdio: ["ignore", "inherit", "inherit"],
        });
        try {
            await expect.poll(async () => {
                try { return (await fetch(origin + "/api/v1/health")).ok; }
                catch { return false; }
            }, { timeout: 20_000 }).toBe(true);
            const token = readFileSync(join(data, "owner-token"), "utf8").trim();
            const response = await fetch(origin + "/api/v1/projects", {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "remote-project" },
                body: JSON.stringify({ root_path: work, name: "원격 전용 프로젝트" }),
            });
            expect(response.status).toBe(201);
            const project = await response.json() as { id: string };
            await use({ origin, token, projectId: project.id });
        } finally {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
            rmSync(work, { recursive: true });
        }
    }, { scope: "worker" }],
});

async function openHosts(page: Page) {
    if (await page.getByRole("banner").count()) {
        await openSettings(page, "local");
        await page.getByRole("button", { name: "기기·연결", exact: true }).click();
    }
    await page.getByRole("button", { name: /^호스트 선택:/ }).click();
    return page.getByRole("dialog", { name: "호스트 관리" });
}

test("로그인 전 호스트 등록·수정·삭제·영속화와 좁은 화면의 키보드 복귀", async ({ page }) => {
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    let dialog = await openHosts(page);
    await dialog.getByLabel("별명", { exact: true }).fill("집 서버");
    await dialog.getByLabel("서버 주소", { exact: true }).fill("https://user:secret@example.test");
    await dialog.getByRole("button", { name: "호스트 추가", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("인증 정보");
    expect(await page.evaluate(() => localStorage.getItem("grove.hosts.v1"))).toBeNull();
    await dialog.getByLabel("서버 주소", { exact: true }).fill("https://EXAMPLE.test:443/");
    await dialog.getByRole("button", { name: "호스트 추가", exact: true }).click();
    await expect(dialog.getByTestId("host-row")).toContainText("https://example.test");
    await dialog.getByRole("button", { name: "수정", exact: true }).click();
    await dialog.getByLabel("별명", { exact: true }).fill("이름 변경");
    await dialog.getByLabel("별명", { exact: true }).press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.closest("dialog") !== null);
    expect(focused).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^호스트 선택:/ })).toBeFocused();
    await page.reload();
    dialog = await openHosts(page);
    await expect(dialog.getByTestId("host-row")).toContainText("이름 변경");
    await dialog.getByRole("button", { name: "삭제", exact: true }).click();
    await expect(dialog.getByText("등록한 호스트가 없습니다.")).toBeVisible();
    await expect(dialog).toHaveJSProperty("scrollWidth", await dialog.evaluate((d) => d.clientWidth));
});

test("두 실제 서버의 인증·지연 응답·이벤트·초안이 섞이지 않고 독립적으로 재접속한다", async ({ page, context, remote }) => {
    const { a } = await ensureProjects();
    const title = `로컬 호스트 대화 ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("메시지 입력").fill("로컬 호스트에서만 보이는 초안");
    const dialog = await openHosts(page);
    await dialog.getByLabel("별명", { exact: true }).fill("다른 서버");
    await dialog.getByLabel("서버 주소", { exact: true }).fill(remote.origin);
    await dialog.getByRole("button", { name: "호스트 추가", exact: true }).click();

    let release!: () => void;
    let received!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { received = resolve; });
    await page.route("**/api/v1/projects?sort=*", async (route) => {
        const response = await route.fetch();
        received();
        await held;
        await route.fulfill({ response });
    });
    try {
        await apiCall("PATCH", `/projects/${a.id}`, { expected_revision: (await apiCall<{ revision: number }>("GET", `/projects/${a.id}`)).revision, name: "로컬 지연 결과" });
        await pending;
        const opened = context.waitForEvent("page");
        await dialog.getByRole("link", { name: "새 탭에서 열기" }).click();
        const other = await opened;
        await other.locator("html[data-hydrated=true]").waitFor();
        expect(new URL(other.url()).origin).toBe(remote.origin);
        expect(await other.evaluate(() => window.opener === null)).toBe(true);
        await expect(other.getByRole("button", { name: "페어링 링크·QR로 등록" })).toBeVisible();
        await registerBrowser(other, remote.origin, remote.token);
        await other.reload();
        await finishSetup(other);
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await expect(other.getByTestId("project-row")).toContainText("원격 전용 프로젝트");
        release();
        await expect(page.getByTestId("project-row").filter({ hasText: "로컬 지연 결과" })).toBeVisible();
        await expect(other.getByText("로컬 지연 결과", { exact: true })).toHaveCount(0);
        await expect(other.getByText(title, { exact: true })).toHaveCount(0);
        await expect(other.getByText("로컬 호스트에서만 보이는 초안", { exact: true })).toHaveCount(0);
        const remoteCopies = await other.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("grove.draft.") || key.startsWith("grove.hosts.")).map(([, value]) => value).join(""));
        expect(remoteCopies).not.toContain("로컬 호스트에서만 보이는 초안");
        expect(remoteCopies).not.toContain("다른 서버");
        await expect(dialog.getByTestId("host-row")).toContainText("최근 열기:");
        await dialog.getByRole("button", { name: "닫기", exact: true }).click();
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).click();

        // 같은 hostname·다른 port에서도 양쪽 refresh 쿠키가 유지된다.
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await expect(page.getByTestId("session-view").getByLabel("메시지 입력")).toHaveValue("");
        await other.reload();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await expect(other.getByTestId("project-row")).toContainText("원격 전용 프로젝트");
        const remoteDialog = await openHosts(other);
        await expect(remoteDialog.getByText("등록한 호스트가 없습니다.")).toBeVisible();
        await remoteDialog.getByRole("button", { name: "닫기", exact: true }).click();

        // 한 호스트의 API 연결 실패·복구는 다른 호스트의 인증·stream을 건드리지 않는다.
        await other.route("**/api/v1/auth/refresh", (route) => route.abort("connectionrefused"));
        await other.reload();
        await expect(other.getByTestId("auth-recovery")).toBeVisible();
        await expect(other.getByRole("form", { name: "로그인" })).toHaveCount(0);
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await expect(page.getByTestId("session-view").getByLabel("메시지 입력")).toHaveValue("");
        await other.unrouteAll();
        await other.reload();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
    }
});
