import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, composerOption, login, runningSendMode, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "전용 CLI fixture로 실행: GROVE_E2E_FAKE_CLI=1");

for (const protocol of ["codex_cli", "claude_code"] as const) {
    test(`${protocol}: 합치기는 같은 Grove 요청과 네이티브 대화를 유지한다`, async () => {
        const root = mkdtempSync(join(state().projA, "native-followup-"));
        const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
        const profile = await apiCall<{ id: string }>("POST", `/agent-backends/${protocol}/connect`);
        const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "native followup" });
        const marker = randomUUID();
        const ready = join(state().cliDir!, `followup-ready-${marker}`);
        const release = join(state().cliDir!, `followup-release-${marker}`);
        const initial = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
            text: `fixture-followup-${marker}`, profile_id: profile.id, tools: false,
        });
        try {
            await expect.poll(() => existsSync(ready)).toBe(true);
            for (const text of ["native-steer-one", "native-steer-two"]) {
                await apiCall("POST", `/sessions/${session.id}/followups`, {
                    kind: "steer", text, profile_id: profile.id, tools: false,
                });
            }
            if (protocol === "codex_cli") {
                await expect.poll(async () => (await apiCall<{ items: unknown[] }>("GET", `/sessions/${session.id}/followups`)).items).toEqual([]);
                expect((await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`)).status).toBe("running");
            }
            writeFileSync(release, "");
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`)).status).toBe("completed");
            const turns = await apiCall<{ id: string }[]>("GET", `/sessions/${session.id}/turns`);
            expect(turns).toEqual([expect.objectContaining({ id: initial.turn.id })]);
            const pending = await apiCall<{ items: unknown[] }>("GET", `/sessions/${session.id}/followups`);
            expect(pending.items).toEqual([]);
            type NativeCall = { provider: string; cwd: string; threadId?: string; input?: { text?: string }[]; text?: string; pid?: number };
            const calls = readFileSync(join(state().cliDir!, "native-turns.jsonl"), "utf8").trim().split("\n")
                .map((line) => JSON.parse(line) as NativeCall).filter((call) => call.cwd === root);
            if (protocol === "codex_cli") {
                expect(calls).toHaveLength(1);
                const requests = readFileSync(join(state().cliDir!, "app-server-requests.jsonl"), "utf8").trim().split("\n")
                    .map((line) => JSON.parse(line)).filter((request) => request.method === "turn/steer" && request.params.threadId === calls[0]!.threadId);
                expect(requests.map((request) => request.params.input[0].text)).toEqual(["native-steer-one", "native-steer-two"]);
            } else {
                expect(calls).toHaveLength(2);
                const next = calls[1]!.text!;
                for (const text of ["native-steer-one", "native-steer-two"]) expect(next.split(text)).toHaveLength(2);
                expect(calls[0]!.threadId).toBeTruthy();
                expect(calls[1]!.threadId).toBe(calls[0]!.threadId);
                expect(calls[0]!.pid).toBeGreaterThan(0);
                expect(calls[1]!.pid).toBe(calls[0]!.pid);
            }
        } finally {
            writeFileSync(release, "");
            const turn = await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`);
            if (["queued", "running", "awaiting_approval"].includes(turn.status))
                await apiCall("POST", `/turns/${initial.turn.id}/cancel`);
        }
    });
}

test.describe("390px Claude 합치기 안내", () => {
    test.use({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    test("입력 중 현재 Claude 실행이 끝난 뒤 반영된다고 표시한다", async ({ page }, info) => {
        const root = mkdtempSync(join(state().projA, "claude-steer-hint-"));
        const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
        const profile = await apiCall<{ id: string }>("POST", "/agent-backends/claude_code/connect");
        const draftProfile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
        const title = `Claude steer hint ${randomUUID()}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await login(page);
        await runningSendMode(page, "steer");
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
        const view = sessionView(page, session.id);
        await composerOption(view, "보내기 방식", "model");
        await composerOption(view, "모델 프로필", JSON.stringify([draftProfile.id, "fixture-codex"]));
        const input = view.getByLabel("메시지 입력");
        const hintText = "현재 Claude 실행이 끝난 뒤 반영돼요.";
        const hint = view.getByText(hintText, { exact: true }).and(view.getByRole("paragraph"));
        await input.fill("추가 지시");
        await expect(hint).toHaveCount(0);
        await input.clear();
        const marker = randomUUID();
        const ready = join(state().cliDir!, `followup-ready-${marker}`);
        const release = join(state().cliDir!, `followup-release-${marker}`);
        const initial = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
            text: `fixture-followup-${marker}`, profile_id: profile.id, tools: false,
        });
        try {
            await expect.poll(() => existsSync(ready)).toBe(true);
            await expect(view.getByTestId("turn-status")).toBeVisible();
            await expect(hint).toHaveCount(0);
            await input.fill("추가 지시");
            await expect(hint).toBeVisible();
            await expect(view.getByRole("button", { name: "합치기", exact: true })).toHaveAccessibleDescription(hintText);
            const { x, width } = (await hint.boundingBox())!;
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x + width).toBeLessThanOrEqual(390);
            await page.screenshot({ path: info.outputPath("claude-steer-hint-390.png"), animations: "disabled" });
            writeFileSync(release, "");
            await expect(hint).toHaveCount(0);
            await expect(input).toHaveValue("추가 지시");
        } finally {
            writeFileSync(release, "");
            const turn = await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`);
            if (["queued", "running", "awaiting_approval"].includes(turn.status)) await apiCall("POST", `/turns/${initial.turn.id}/cancel`);
        }
    });
});

for (const width of [390, 1400]) {
    test.describe(`${width}px native 합치기 전달`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("접수 확인 전에는 전달 중이고, 확인 뒤 실행 종료를 기다리지 않고 목록에서 사라진다", async ({ page }, info) => {
            const root = mkdtempSync(join(state().projA, "live-steer-ui-"));
            const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
            const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
            const title = `native merge ${randomUUID()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const view = sessionView(page, session.id);
            await composerOption(view, "보내기 방식", "model");
            await composerOption(view, "모델 프로필", JSON.stringify([profile.id, "fixture-codex"]));
            await runningSendMode(page, "steer");
            const marker = randomUUID();
            const ready = join(state().cliDir!, `followup-ready-${marker}`);
            const release = join(state().cliDir!, `followup-release-${marker}`);
            const ack = join(state().cliDir!, `steer-ack-release-${marker}`);
            const started = page.waitForResponse((response) => response.request().method() === "POST"
                && response.url().endsWith(`/sessions/${session.id}/turns`));
            await view.getByLabel("메시지 입력").fill(`fixture-followup-${marker} fixture-steer-ack-hold`);
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            const initial = await (await started).json() as { turn: { id: string } };
            try {
                await expect.poll(() => existsSync(ready)).toBe(true);
                await expect(view.getByTestId("turn-status")).toBeVisible();
                await view.getByLabel("메시지 입력").fill("실행 중에 바로 합칠 지시");
                await expect(view.getByText("현재 Claude 실행이 끝난 뒤 반영돼요.", { exact: true })).toHaveCount(0);
                await view.getByRole("button", { name: "합치기", exact: true }).click();
                const pending = view.getByTestId("followup");
                await expect(pending).toContainText("전달 중");
                await expect(pending.getByRole("button", { name: /대기 메시지 삭제/ })).toBeDisabled();
                const list = await apiCall<{ items: { id: string; delivery_state: string }[] }>("GET", `/sessions/${session.id}/followups`);
                expect(list.items[0]!.delivery_state).toBe("sending");
                await expect(apiCall("DELETE", `/sessions/${session.id}/followups/${list.items[0]!.id}`)).rejects.toThrow("409");
                await page.screenshot({ path: info.outputPath(`native-steer-${width}.png`), animations: "disabled" });
                writeFileSync(ack, "");
                await expect(view.getByTestId("followups")).toHaveCount(0);
                await expect(view.getByTestId("msg-user").filter({ hasText: "실행 중에 바로 합칠 지시" })).toHaveCount(1);
                expect((await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`)).status).toBe("running");
                writeFileSync(release, "");
                await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`)).status).toBe("completed");
                expect(await apiCall<unknown[]>("GET", `/sessions/${session.id}/turns`)).toHaveLength(1);
            } finally {
                writeFileSync(ack, "");
                writeFileSync(release, "");
                const turn = await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`);
                if (["queued", "running", "awaiting_approval"].includes(turn.status)) await apiCall("POST", `/turns/${initial.turn.id}/cancel`);
            }
        });
    });
}

test("이미지 합치기를 전달 중 취소하면 결과 불명으로 보존하고 자동·수동 재실행을 막는다", async () => {
    const root = mkdtempSync(join(state().projA, "native-steer-cancel-"));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "native steer cancel" });
    const image = await apiCall<{ id: string }>("POST", `/projects/${project.id}/attachments`, {
        name: "fixture.png", data_base64: readFileSync(new URL("../public/icon-192.png", import.meta.url)).toString("base64"),
    });
    const marker = randomUUID();
    const release = join(state().cliDir!, `followup-release-${marker}`);
    const ack = join(state().cliDir!, `steer-ack-release-${marker}`);
    const initial = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
        text: `fixture-followup-${marker} fixture-steer-ack-hold`, profile_id: profile.id, tools: false,
    });
    try {
        await expect.poll(() => existsSync(join(state().cliDir!, `followup-ready-${marker}`))).toBe(true);
        const item = await apiCall<{ followup: { id: string } }>("POST", `/sessions/${session.id}/followups`, {
            kind: "steer", text: "이미지 추가 지시", attachments: [image.id], profile_id: profile.id, tools: false,
        });
        await expect.poll(() => existsSync(join(state().cliDir!, `steer-ack-ready-${marker}`))).toBe(true);
        const wire = readFileSync(join(state().cliDir!, "app-server-requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
            .find((request) => request.method === "turn/steer" && request.params.clientUserMessageId === item.followup.id);
        expect(wire.params.input[0].text).toBe("이미지 추가 지시");
        expect(wire.params.input[1].type).toBe("localImage");
        expect(existsSync(wire.params.input[1].path)).toBe(true);
        await apiCall("POST", `/turns/${initial.turn.id}/cancel`);
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`)).status).toBe("cancelled");
        const pending = await apiCall<{ items: { id: string; delivery_state: string; last_error: { code: string } }[] }>("GET", `/sessions/${session.id}/followups`);
        expect(pending.items).toHaveLength(1);
        expect(pending.items[0]!.delivery_state).toBe("unknown");
        expect(pending.items[0]!.last_error.code).toBe("steer_delivery_unknown");
        await expect(apiCall("POST", `/sessions/${session.id}/followups/${item.followup.id}/start`)).rejects.toThrow("409");
        expect(await apiCall<unknown[]>("GET", `/sessions/${session.id}/turns`)).toHaveLength(1);
        await apiCall("DELETE", `/sessions/${session.id}/followups/${item.followup.id}`);
    } finally {
        writeFileSync(ack, "");
        writeFileSync(release, "");
        const turn = await apiCall<{ status: string }>("GET", `/turns/${initial.turn.id}`);
        if (["queued", "running", "awaiting_approval"].includes(turn.status)) await apiCall("POST", `/turns/${initial.turn.id}/cancel`);
    }
});
