import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openProjectFiles, openTool, state, useWorkspaces } from "./helpers";

async function project() {
    const root = mkdtempSync(join(dirname(state().projA), "read-load-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    writeFileSync(join(root, "anchor.txt"), "base\n");
    run("add", "anchor.txt");
    run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
    const p = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    return { root, ...p };
}

for (const width of [390, 1400]) {
    test.describe(`${width}px 읽기 부하`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

        test("파일 탐색은 페이지 밖까지 검색하고 한 번에 50개 행만 표시한다", async ({ page }, info) => {
            const p = await project();
            mkdirSync(join(p.root, "nested"));
            writeFileSync(join(p.root, "nested", "child.txt"), "child");
            for (let i = 0; i < 120; i++) writeFileSync(join(p.root, `item-${String(i).padStart(3, "0")}.txt`), `${i}\n`);
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: p.name, exact: true }).click();
            await openProjectFiles(page);
            const files = page.getByTestId("files-view").filter({ visible: true });
            await expect(files.getByTestId("file-row")).toHaveCount(50);
            await expect(files).toContainText("전체 122개");
            const folder = files.getByRole("button", { name: /📁 nested/ });
            const folderRead = (url: URL) => url.pathname.endsWith(`/projects/${p.id}/files`) && url.searchParams.get("path") === "nested";
            const requests: string[] = [];
            page.on("request", (request) => { if (folderRead(new URL(request.url()))) requests.push(request.url()); });
            const warmed = page.waitForResponse((response) => folderRead(new URL(response.url())));
            await folder.focus();
            await warmed;
            await expect(files.getByRole("button", { name: "child.txt", exact: true })).toHaveCount(0);
            await folder.click();
            await expect(files.getByRole("button", { name: "child.txt", exact: true })).toBeVisible();
            expect(requests).toHaveLength(1);
            await files.getByRole("button", { name: "상위 폴더" }).click();
            await files.getByRole("button", { name: "파일 다음 페이지", exact: true }).click();
            await expect(files.getByRole("button", { name: "item-049.txt", exact: true })).toBeVisible();
            await expect(files.getByTestId("file-row")).toHaveCount(50);
            await files.getByRole("searchbox", { name: "파일 이름 거르기", exact: true }).fill("item-119");
            await expect(files.getByTestId("file-row")).toHaveCount(1);
            await expect(files.getByRole("button", { name: "item-119.txt", exact: true })).toBeVisible();
            await page.screenshot({ path: info.outputPath(`file-page-${width}.png`), animations: "disabled" });
        });

        test("업로드를 기다리는 중에도 다른 폴더에 파일을 추가하고 각 파일을 고른 경로에 저장한다", async ({ page }) => {
            const p = await project();
            mkdirSync(join(p.root, "nested"));
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: p.name, exact: true }).click();
            await openTool(page, "파일");
            const files = page.getByTestId("files-view").filter({ visible: true });
            const input = files.locator('input[type="file"]');
            const file = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(name) });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const paths: string[] = [];
            await page.route(`**/projects/${p.id}/files/upload`, async (route) => {
                paths.push(route.request().postDataJSON().path);
                await gate;
                await route.continue();
            });
            try {
                await input.setInputFiles([file("a.txt"), file("b.txt")]);
                await expect.poll(() => paths).toEqual(["a.txt"]);
                await files.getByRole("button", { name: /📁 nested/ }).click();
                await expect(files.getByRole("button", { name: "상위 폴더" })).toBeVisible();
                await input.setInputFiles(file("c.txt"));
                await page.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
                await expect(files).toHaveCount(0);
                release();
                await expect.poll(() => existsSync(join(p.root, "nested/c.txt"))).toBe(true);
                expect(paths).toEqual(["a.txt", "b.txt", "nested/c.txt"]);
                for (const path of paths) expect(readFileSync(join(p.root, path), "utf8")).toBe(path.split("/").at(-1));
            } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
        });

        test("Git에서 늦게 도착한 첫 파일 응답이 다음 파일의 변경 내용을 덮지 않는다", async ({ page }) => {
            const p = await project();
            writeFileSync(join(p.root, "anchor.txt"), "changed\n");
            writeFileSync(join(p.root, "second.txt"), "second\n");
            await useWorkspaces(p.id);
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: p.name, exact: true }).click();
            await openTool(page, "변경");
            const git = page.getByTestId("git-panel").filter({ visible: true });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const hunks = (url: URL) => url.pathname.endsWith(`/projects/${p.id}/git/hunks`);
            await page.route(hunks, async (route) => {
                const name = new URL(route.request().url()).searchParams.get("path");
                if (name === "anchor.txt") await gate;
                await route.fulfill({ json: { hunks: [`diff ${name}`], fingerprint: "fixture" } });
            });
            try {
                await git.getByRole("button", { name: "anchor.txt", exact: true }).click();
                await expect(git.getByText("변경 내용 불러오는 중…")).toBeVisible();
                await git.getByRole("button", { name: "second.txt", exact: true }).click();
                await expect(git.getByTestId("hunk")).toContainText("diff second.txt");
                const first = page.waitForResponse((r) => hunks(new URL(r.url())) && r.url().endsWith("path=anchor.txt"));
                release();
                await (await first).finished();
                await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                await expect(git.getByTestId("hunk")).toContainText("diff second.txt");
            } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
        });

        test("숨긴 Git 패널은 파일 이벤트로 조회하지 않고 다시 열면 초안과 최신 상태를 유지한다", async ({ page }) => {
            const p = await project();
            await useWorkspaces(p.id);
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: p.name, exact: true }).click();
            await openTool(page, "변경");
            const git = page.getByTestId("git-panel").filter({ visible: true });
            await expect(git.getByRole("heading", { name: "작업 트리 변경 (0)", exact: true })).toBeVisible();
            await git.getByLabel("stash 메시지").fill("패널을 닫아도 보존할 초안");
            await page.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
            await expect(git).toHaveCount(0);
            const hiddenReads: string[] = [];
            let hidden = true;
            page.on("request", (request) => {
                if (hidden && new URL(request.url()).pathname.startsWith(`/api/v1/projects/${p.id}/git/`)) hiddenReads.push(request.url());
            });
            const file = await apiCall<{ sha256: string }>("GET", `/projects/${p.id}/files/content?path=anchor.txt`);
            await apiCall("PUT", `/projects/${p.id}/files/content`, { path: "anchor.txt", expected_sha256: file.sha256, text: "changed\n" });
            const barrier = `이벤트 확인 ${Date.now()}`;
            await apiCall("POST", `/projects/${p.id}/sessions`, { title: barrier });
            // 같은 SSE 흐름의 뒤쪽 이벤트가 사이드바에 반영되면 앞의 file.changed도 이미 처리됐다.
            await expect(page.getByTestId("sidebar-session").filter({ hasText: barrier })).toHaveCount(1);
            expect(hiddenReads).toEqual([]);
            hidden = false;
            await openTool(page, "변경");
            await expect(git.getByLabel("stash 메시지")).toHaveValue("패널을 닫아도 보존할 초안");
            await expect(git.getByRole("heading", { name: "작업 트리 변경 (1)", exact: true })).toBeVisible();
        });
    });
}

test.describe("390px 변경 이력 페이지", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test("페이지 밖의 변경까지 요청 전체를 되돌리고 다시 적용한다", async ({ page }, info) => {
        const p = await project();
        const title = `대량 변경 ${Date.now()}`;
        const s = await apiCall<{ id: string }>("POST", `/projects/${p.id}/sessions`, { title });
        const patch = `*** Begin Patch\n${Array.from({ length: 121 }, (_, i) => `*** Add File: bulk/item-${String(i).padStart(3, "0")}.txt\n+${i}\n`).join("")}*** End Patch\n`;
        const call = await apiCall<{ id: string }>("POST", `/sessions/${s.id}/tool-requests`, { name: "apply_patch", args: { patch } });
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/tool-calls/${call.id}`)).status).toBe("succeeded");
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: p.id, resource_id: s.id });
        await login(page);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
        await openTool(page.getByTestId("session-view"), "변경");
        const changes = page.getByTestId("changes-panel").filter({ visible: true });
        await expect(changes.getByTestId("change-row")).toHaveCount(50);
        await expect(changes).toContainText("파일 변경 이력 · 121/121");
        await changes.getByRole("button", { name: "변경 이력 다음 페이지", exact: true }).click();
        await expect(changes.getByTestId("change-row")).toHaveCount(50);
        await expect(changes).toContainText("2페이지");
        await changes.getByRole("button", { name: "이 요청의 변경 되돌리기", exact: true }).click();
        await expect(changes).toContainText("파일 변경 이력 · 0/121");
        expect(existsSync(join(p.root, "bulk/item-000.txt"))).toBe(false);
        expect(existsSync(join(p.root, "bulk/item-120.txt"))).toBe(false);
        await changes.getByRole("button", { name: "다시 적용", exact: true }).first().click();
        await expect(changes).toContainText("파일 변경 이력 · 121/121");
        expect(readFileSync(join(p.root, "bulk/item-120.txt"), "utf8")).toBe("120\n");
        await page.screenshot({ path: info.outputPath("changes-page-390.png"), animations: "disabled" });
    });
});
