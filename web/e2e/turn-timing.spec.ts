import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiCall, ensureProfile, ensureProjects, login, script, selectChoice, sessionView, state } from "./helpers";
import { frames } from "./fixture";

type Detail = { id: string; status: string; timing: { total_ms: number; running: boolean } };

async function timingSetting(page: Page, title: string, enabled: boolean) {
    await page.getByRole("button", { name: "설정", exact: true }).first().click();
    await page.getByLabel("설정 검색", { exact: true }).fill("턴 경과");
    await selectChoice(page.getByRole("combobox", { name: "턴 시간 표시", exact: true }), String(enabled));
    // 탭 버튼 이름은 "프로젝트 이름 + 대화 제목"이다.
    await page.getByRole("tab").getByRole("button", { name: title }).click();
}

test("진행·완료 시간은 기기 시계 ±5분에도 서버와 같고 끄기는 새로고침 뒤에도 유지된다", async ({ page }) => {
    const profile = await ensureProfile();
    const { a } = await ensureProjects();
    const title = `turn timing ${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    let active: string | undefined;
    try {
        await script({ frames: frames.text(["진행 중"]).slice(0, 1), hang: true, marker: title });
        const started = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: title, profile_id: profile });
        active = started.turn.id;
        const timing = view.getByTestId("turn-timing");
        await expect(timing).toHaveAttribute("data-running", "true");
        await expect(timing).toContainText(/[\d.]+초/);
        await expect(timing).not.toContainText("총 경과");
        const actualNow = Date.now();
        for (const skew of [300_000, -300_000]) {
            await page.clock.setFixedTime(actualNow + skew);
            await expect.poll(async () => {
                const server = await apiCall<Detail>("GET", `/turns/${active}`);
                const displayed = Number(await timing.getAttribute("data-elapsed-ms"));
                // 조회·렌더 왕복 차이만 허용한다. ±5분 시계 차이는 이 범위를 벗어난다.
                return Math.abs(displayed - server.timing.total_ms);
            }).toBeLessThan(3000);
        }
        await timingSetting(page, title, false);
        await expect(timing).toHaveCount(0);
        await page.reload();
        await expect(view).toBeVisible();
        await expect(timing).toHaveCount(0);
        await timingSetting(page, title, true);
        await expect(timing).toHaveAttribute("data-running", "true");
        await apiCall("POST", `/turns/${active}/cancel`);
        await expect(timing).toHaveAttribute("data-running", "false");
        active = undefined;

        const doneMarker = `${title} done`;
        await script({ frames: frames.text(["완료"]), marker: doneMarker });
        const done = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: doneMarker, profile_id: profile });
        active = done.turn.id;
        await expect.poll(async () => (await apiCall<Detail>("GET", `/turns/${done.turn.id}`)).status).toBe("completed");
        active = undefined;
        const detail = await apiCall<Detail>("GET", `/turns/${done.turn.id}`);
        await expect(timing).toHaveAttribute("data-elapsed-ms", String(detail.timing.total_ms));
        await expect(timing).toContainText("요청");
        await page.reload();
        await expect(view.getByTestId("turn-timing")).toHaveAttribute("data-elapsed-ms", String(detail.timing.total_ms));
    } finally {
        if (active) await apiCall("POST", `/turns/${active}/cancel`);
    }
});

async function freePort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("시험 포트를 할당하지 못했습니다");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
}

test("격리 서버를 실제 재시작하면 진행 턴은 중단으로 복구되고 시간이 더 늘지 않는다", async ({ page }) => {
    // 공용 E2E 서버·데이터에는 손대지 않고 이 시험 소유 프로세스만 재시작한다.
    const root = new URL("../..", import.meta.url).pathname;
    const work = mkdtempSync(join(tmpdir(), "grove-turn-timing-"));
    const data = join(work, "data");
    const projectRoot = mkdtempSync(join(work, "project-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const bin = process.env.GROVE_BIN ?? join(root, "target/debug/grove");
    const launch = () => spawn(bin, ["serve", "--listen", `127.0.0.1:${port}`, "--data-dir", data], {
        env: { ...process.env, GROVE_WEB_DIR: join(root, "web/build/client"), GROVE_LOG: "warn" },
        stdio: ["ignore", "ignore", "inherit"],
    });
    const ready = async () => {
        await expect.poll(async () => {
            try { return (await fetch(`${base}/api/v1/health`)).ok; }
            catch { return false; }
        }, { timeout: 10_000 }).toBe(true);
    };
    let child = launch();
    try {
        await ready();
        const token = readFileSync(join(data, "owner-token"), "utf8").trim();
        const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
            const response = await fetch(`${base}/api/v1${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`격리 시험 API: ${method} ${path}: ${response.status}`);
            return await response.json() as T;
        };
        const project = await request<{ id: string }>("POST", "/projects", { root_path: projectRoot });
        const title = `restart timing ${Date.now()}`;
        const session = await request<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
        const profile = await request<{ id: string }>("POST", "/model-profiles", {
            name: "timing fixture", protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
        });
        await request("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await page.goto(base);
        await page.getByLabel("토큰").fill(token);
        await page.getByRole("button", { name: "로그인" }).click();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
        await script({ frames: frames.text(["재시작 전"]).slice(0, 1), hang: true, marker: title });
        const started = await request<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: title, profile_id: profile.id });
        const view = sessionView(page, session.id);
        await expect(view.getByTestId("partial")).toContainText("재시작 전");
        await expect(view.getByTestId("turn-timing")).toHaveAttribute("data-running", "true");
        await stop(child);
        child = launch();
        await ready();
        const restored = await request<Detail>("GET", `/turns/${started.turn.id}`);
        expect(restored.status).toBe("interrupted");
        expect(restored.timing.running).toBe(false);
        await page.reload();
        const timing = view.getByTestId("turn-timing");
        await expect(timing).toContainText("중단");
        await expect(timing).toHaveAttribute("data-elapsed-ms", String(restored.timing.total_ms));
        await page.clock.install();
        await page.clock.fastForward(60_000);
        await expect(timing).toHaveAttribute("data-elapsed-ms", String(restored.timing.total_ms));
        const later = await request<Detail>("GET", `/turns/${started.turn.id}`);
        expect(later.timing).toEqual(restored.timing);
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
    } finally {
        await stop(child);
    }
});
