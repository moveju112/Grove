// 폰과 같은 relay 경로의 연결 수명 시험. 대상: 로컬 스택(기본) 또는 GROVE_RELAY_STATE로 지정한 스테이징.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composerOption, openProjectFiles } from "../e2e/helpers";
import { api, enter, expectNoConnectionNoise, freeze, net, target } from "./relay";

const local = () => target().target === "local";

/// relay endpoint로 열린 WebSocket 수. HTTP 요청은 모두 하나의 다중화 연결을 공유해야 한다.
function countRelaySockets(page: Page) {
    const endpoint = new URL(target().endpoint);
    const opened: string[] = [];
    page.on("websocket", (ws) => { if (new URL(ws.url()).host === endpoint.host) opened.push(ws.url()); });
    return opened;
}

async function project(name: string, files: Record<string, string> = {}) {
    const root = mkdtempSync(join(local() ? target().work : tmpdir(), `${name}-`));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
    return api<{ id: string; name: string }>("POST", "/projects", { root_path: root });
}

async function openProject(page: Page, name: string) {
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByTestId("project-row").getByRole("button", { name, exact: true }).click();
    const view = page.locator(".project-view").filter({ visible: true });
    await expect(view.getByLabel("메시지 입력", { exact: true })).toBeVisible();
    return view;
}

test.afterEach(async () => {
    if (local()) { await net("delay", 0); await net("blackhole", false); }
});

test("첫 화면·프로젝트·메시지 저장은 암호화 연결 하나로 동작한다", async ({ page }, info) => {
    const p = await project("relay-first");
    const sockets = countRelaySockets(page);
    const started = Date.now();
    await enter(page);
    info.annotations.push({ type: "first-screen-ms", description: String(Date.now() - started) });
    const view = await openProject(page, p.name);
    await composerOption(view, "보내기 방식", "save");
    await expect(view.locator(".view-head h1")).toHaveText(p.name);
    await page.screenshot({ path: info.outputPath("relay-project-390.png") });
    const text = `relay 저장 ${Date.now()}`;
    await view.getByLabel("메시지 입력", { exact: true }).fill(text);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(page.getByTestId("session-view").filter({ visible: true }).getByTestId("msg-user")).toContainText(text);
    await expectNoConnectionNoise(page);
    // 연결 확인·로그인·목록·이벤트·전송이 모두 같은 연결을 쓴다(요청마다 새 연결을 열지 않음).
    expect(sockets.length, sockets.join("\n")).toBe(1);
});

test("백그라운드 중 소켓이 정리돼도 복귀 후 오류 없이 다시 연결한다", async ({ page }) => {
    const p = await project("relay-resume");
    const sockets = countRelaySockets(page);
    await enter(page);
    await openProject(page, p.name);
    await freeze(page, async () => {
        // 로컬: OS가 백그라운드 탭의 소켓을 끊은 상황. 스테이징: 잠시 네트워크가 사라진 상황.
        if (local()) await net("cut");
        else { await page.context().setOffline(true); await new Promise((r) => setTimeout(r, 3_000)); await page.context().setOffline(false); }
    });
    // 복귀 직후 사용자가 바로 조작한다. 오류 없이 새 연결로 이어져야 한다.
    const view = await openProject(page, p.name);
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 20_000 });
    await expect(page.getByTestId("connection-toast")).toHaveCount(0, { timeout: 15_000 });
    await expect(view.getByLabel("메시지 입력", { exact: true })).toBeEnabled();
    await expectNoConnectionNoise(page);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
});

test("응답 없는 죽은 연결은 확인 후 새로 연결하고 화면별 오류를 띄우지 않는다", async ({ page }, info) => {
    test.skip(!local(), "응답 없는 연결 주입은 로컬 스택에서만 가능하다");
    const p = await project("relay-dead");
    const sockets = countRelaySockets(page);
    await enter(page);
    await openProject(page, p.name);
    // 연결은 열린 채 아무 frame도 오가지 않는다. heartbeat(15초)+응답 대기(10초) 안에 죽은 연결로 판단해야 한다.
    await net("blackhole", true);
    await expect.poll(() => sockets.length, { timeout: 40_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("connection-toast")).toBeVisible({ timeout: 20_000 });
    await expectNoConnectionNoise(page);
    await page.screenshot({ path: info.outputPath("relay-connection-toast-390.png") });
    await net("blackhole", false);
    const view = await openProject(page, p.name);
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 30_000 });
    await expect(page.getByTestId("connection-toast")).toHaveCount(0, { timeout: 15_000 });
    await expect(view.getByLabel("메시지 입력", { exact: true })).toBeEnabled();
    await expectNoConnectionNoise(page);
});

test("지연이 있어도 큰 파일은 흐름 제어 창을 넘어 끝까지 전달된다", async ({ page }) => {
    // 48KB chunk × 8(ACK 창)보다 큰 본문. 창이 막히거나 ACK를 잃으면 끝까지 오지 않는다.
    const content = Array.from({ length: 12_000 }, (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(40)}`).join("\n");
    const p = await project("relay-large", { "large.txt": content });
    await enter(page);
    if (local()) await net("delay", 80);
    await openProject(page, p.name);
    await openProjectFiles(page);
    const files = page.getByTestId("files-view").filter({ visible: true });
    await files.getByRole("button", { name: "large.txt", exact: true }).click();
    await expect(files.getByLabel("파일 내용")).toHaveValue(content, { timeout: 30_000 });
    await expectNoConnectionNoise(page);
});
