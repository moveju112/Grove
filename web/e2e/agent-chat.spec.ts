import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, closeModelSettings, composerSetting, login, openDetails, removeProfiles, sessionView, startProjectConversation, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "전용 CLI fixture로 실행: GROVE_E2E_FAKE_CLI=1");

async function cleanup(projectId: string, profileId?: string) {
    const owned = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${projectId}/sessions`);
    for (const session of owned.items) {
        const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${session.id}/turns`);
        for (const turn of turns.filter((turn) => ["running", "queued", "awaiting_approval"].includes(turn.status))) {
            await apiCall("POST", `/turns/${turn.id}/cancel`);
        }
        await expect.poll(async () => (await apiCall<{ status: string }[]>("GET", `/sessions/${session.id}/turns`))
            .some((turn) => ["running", "queued", "awaiting_approval"].includes(turn.status))).toBe(false);
    }
    if (profileId) await apiCall("DELETE", `/model-profiles/${profileId}`);
    const project = await apiCall<{ revision: number }>("GET", `/projects/${projectId}`);
    await apiCall("PATCH", `/projects/${projectId}`, { expected_revision: project.revision, archived: true });
}

for (const width of [390, 1280]) {
    test(`에이전트 연결부터 응답 유실 복구·연속 대화·재접속·취소까지 (${width}px)`, async ({ page }, info) => {
        // 앞선 일반 대화 시험이 만든 fixture만 비워 첫 연결 상태를 재현한다.
        await removeProfiles((name) => name === "fixture");
        await page.setViewportSize({ width, height: 844 });
        const root = mkdtempSync(join(state().projA, "agent-chat-"));
        const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
        let reads = 0;
        await page.route(`**/api/v1/projects/${project.id}`, async (route) => {
            if (++reads === 1) await route.abort("failed");
            else await route.continue();
        });
        let sessionId: string | undefined;
        let profileId: string | undefined;
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            await login(page);
            const toggle = page.getByRole("button", { name: "사이드바", exact: true });
            if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
            if (width < 760) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
            await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
            const connect = page.getByTestId("agent-connect");
            await expect(connect).toBeVisible();
            expect(reads).toBe(2);
            const input = page.getByLabel("메시지 입력");
            await input.fill("fixture-chat:first");
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: info.outputPath("connect.png") });
            await connect.getByRole("button", { name: "Codex", exact: true }).click();
            await expect(connect).toHaveCount(0);
            expect(errors).toEqual([]);
            expect((await apiCall<{ items: unknown[] }>("GET", `/projects/${project.id}/sessions`)).items).toHaveLength(0);
            await expect(input).toHaveValue("fixture-chat:first");
            profileId = (await (await composerSetting(page, "모델 프로필")).getAttribute("data-selected-value"))!;
            await closeModelSettings(page);

            // 서버는 접수했지만 클라이언트는 응답을 못 받는다. 재확인은 같은 대화·턴 하나만 만든다.
            const keys: string[] = [];
            await page.route("**/api/v1/sessions/*/turns", async (route) => {
                if (route.request().method() !== "POST") return route.continue();
                keys.push(route.request().headers()["idempotency-key"]!);
                if (keys.length === 1) {
                    await route.fetch();
                    await route.abort("failed");
                } else await route.continue();
            });
            await page.getByRole("button", { name: "보내기", exact: true }).click();
            await page.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
            await expect(page.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 1");
            expect(keys).toHaveLength(2);
            expect(keys[0]).toBe(keys[1]);
            const sessions = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
            expect(sessions.items).toHaveLength(1);
            sessionId = sessions.items[0]!.id;
            expect(await apiCall<unknown[]>("GET", `/sessions/${sessionId}/turns`)).toHaveLength(1);

            await page.reload();
            const view = sessionView(page, sessionId);
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 1");
            await view.getByLabel("메시지 입력").fill("fixture-chat:second");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 2");
            await expect(view.getByTestId("turn-status")).toHaveCount(0);
            await expect.poll(async () => {
                const reply = await view.getByTestId("msg-assistant").last().boundingBox();
                const composer = await view.getByTestId("composer").boundingBox();
                const top = await view.evaluate((node) => node.closest('[data-testid="pane-body"]')!.getBoundingClientRect().top);
                return reply!.y >= top && reply!.y + reply!.height <= composer!.y;
            }).toBe(true);
            await page.screenshot({ path: info.outputPath("chat.png") });

            await view.getByLabel("메시지 입력").fill("fixture-hold");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("partial")).toContainText("중단 대기 중");
            const pid = Number(readFileSync(join(state().cliDir!, "last-pid"), "utf8"));
            await page.reload();
            await expect(view.getByTestId("partial")).toContainText("중단 대기 중");
            await view.getByTestId("turn-status").getByRole("button", { name: "취소", exact: true }).click();
            await expect(view.getByTestId("turn-status")).toHaveCount(0);
            await expect.poll(() => {
                try { process.kill(pid, 0); return false; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
            }).toBe(true);
            const turns = await apiCall<{ status: string }[]>("GET", `/sessions/${sessionId}/turns`);
            expect(turns.filter((turn) => turn.status === "cancelled")).toHaveLength(1);
            const interrupted = view.getByTestId("turn-evidence");
            await expect(interrupted).toContainText("CLI 작업 중단 · 변경 여부 확인 필요");
            await openDetails(interrupted);
            await expect(interrupted.getByRole("dialog")).toContainText("중단해도 이미 바뀐 파일은 되돌아가지 않아요");
            await page.screenshot({ path: info.outputPath("cancelled.png"), animations: "disabled" });
            await page.keyboard.press("Escape");
            await view.getByLabel("메시지 입력").fill("fixture-chat:after-cancel");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 4");
        } finally {
            await cleanup(project.id, profileId);
        }
    });
}

test("등록한 모바일 기기는 암호화 연결로 에이전트와 대화하고 재접속 뒤 이어 쓴다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const root = mkdtempSync(join(state().projA, "encrypted-chat-"));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
    const identity = await apiCall<{ key: string }>("GET", "/e2ee/identity");
    const password = "agent-chat test-only password";
    const plaintext: string[] = [];
    const wire: Buffer[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/v1/")) plaintext.push(new URL(request.url()).pathname); });
    page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => wire.push(Buffer.from(payload)));
        socket.on("framereceived", ({ payload }) => wire.push(Buffer.from(payload)));
    });
    try {
        const pairing = await apiCall<{ code: string; id: string }>("POST", "/pairings", { name: "agent-chat-mobile", password });
        await page.goto("/#" + new URLSearchParams({ connect: "ws://127.0.0.1:17741/api/e2ee", key: identity.key, pairing: pairing.code }));
        await page.getByRole("button", { name: "서버 확인 후 연결" }).click();
        await page.getByRole("button", { name: "연결", exact: true }).click();
        await page.getByLabel("비밀번호", { exact: true }).fill(password);
        await page.getByRole("button", { name: "연결 요청", exact: true }).click();
        const verification = await page.getByTestId("pairing-code").innerText();
        const pairs = await apiCall<{ id: string; requests: { id: string; verification_code: string }[] }[]>("GET", "/pairings");
        const request = pairs.find((pair) => pair.id === pairing.id)!.requests.find((request) => request.verification_code === verification)!;
        await apiCall("POST", `/pairings/${pairing.id}/requests/${request.id}`, {});
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        const toggle = page.getByRole("button", { name: "사이드바", exact: true });
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
        await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        await startProjectConversation(page.getByTestId("project-view").filter({ visible: true }));
        await page.getByLabel("메시지 입력").fill("encrypted-agent-chat-first");
        await page.getByRole("button", { name: "보내기", exact: true }).click();
        const owned = await apiCall<{ items: { id: string }[] }>("GET", `/projects/${project.id}/sessions`);
        expect(owned.items).toHaveLength(1);
        await expect.poll(async () => (await apiCall<{ status: string }[]>("GET", `/sessions/${owned.items[0]!.id}/turns`)).map((turn) => turn.status))
            .toEqual(["completed"]);
        await expect(page.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 1");
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await page.getByLabel("메시지 입력").fill("encrypted-agent-chat-second");
        await page.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(page.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 2");
        expect(plaintext).toEqual([]);
        expect(wire.some((frame) => frame.includes(Buffer.from("encrypted-agent-chat-first")) || frame.includes(Buffer.from(pairing.code)))).toBe(false);
    } finally {
        await cleanup(project.id, profile.id);
    }
});

test("설정의 에이전트 연결은 반복해도 하나이며 삭제 후 새 연결을 만든다", async ({ page }) => {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("모델 프로필");
    const section = page.getByTestId("setting-profiles");
    await section.getByText("CLI 에이전트 연결", { exact: true }).click();
    const connect = section.getByTestId("agent-connect");
    let current: string | undefined;
    try {
        await connect.getByRole("button", { name: "Codex", exact: true }).click();
        await expect(connect.getByRole("status").filter({ hasText: /\S/ })).toContainText("프로필 준비됨");
        const first = (await apiCall<{ id: string; protocol: string }[]>("GET", "/model-profiles")).filter((profile) => profile.protocol === "codex_cli");
        expect(first).toHaveLength(1);
        current = first[0]!.id;
        await connect.getByRole("button", { name: "Codex", exact: true }).click();
        await expect(connect.getByRole("status").filter({ hasText: /\S/ })).toContainText("프로필 준비됨");
        expect((await apiCall<{ protocol: string }[]>("GET", "/model-profiles")).filter((profile) => profile.protocol === "codex_cli")).toHaveLength(1);
        await apiCall("DELETE", `/model-profiles/${current}`);
        await expect(section.getByTestId("model-profile").filter({ hasText: "Codex" })).toHaveCount(0);
        await connect.getByRole("button", { name: "Codex", exact: true }).click();
        await expect(section.getByTestId("model-profile").filter({ hasText: "Codex" })).toHaveCount(1);
        const second = (await apiCall<{ id: string; protocol: string }[]>("GET", "/model-profiles")).filter((profile) => profile.protocol === "codex_cli");
        expect(second[0]!.id).not.toBe(current);
        current = second[0]!.id;
    } finally {
        const profiles = await apiCall<{ id: string }[]>("GET", "/model-profiles");
        if (current && profiles.some((profile) => profile.id === current)) await apiCall("DELETE", `/model-profiles/${current}`);
    }
});
