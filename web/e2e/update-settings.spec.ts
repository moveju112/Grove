import { expect, test, type Page } from "@playwright/test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, openSettings, selectChoice } from "./helpers";
import { STATE } from "./global-setup";
import type { ServerUpdateStatus } from "../app/api/updateSettings";

async function open(page: Page) {
    await openSettings(page);
    await page.getByLabel("설정 검색").last().fill("서버 업데이트");
    return page.getByTestId("server-update-settings").last();
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
}
function localSource(server: ServerUpdateStatus) {
    const { work } = JSON.parse(readFileSync(STATE, "utf8")) as { work: string };
    const root = mkdtempSync(join(work, "update-settings-"));
    const source = join(work, "data", "update-source.json");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const keyId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    writeFileSync(join(root, "trusted-keys.json"), JSON.stringify({ keys: [{ key_id: keyId, public_key: raw.toString("base64") }] }));
    writeFileSync(source, JSON.stringify({ root, manifests: { stable: join(root, "stable.json"), beta: join(root, "beta.json") } }));
    const manifest = (channel: "stable" | "beta", version: string) => {
        const signed = { product: "grove", channel, version, protocol: server.server.protocol, schema: server.server.schema,
            issued_at: "2026-09-21T00:00:00Z", artifacts: {} };
        writeFileSync(join(root, `${channel}.json`), JSON.stringify({
            signed, signatures: [{ key_id: keyId, sig: sign(null, Buffer.from(canonical(signed)), privateKey).toString("base64") }],
        }));
    };
    return { root, manifest, close: () => { rmSync(source); rmSync(root, { recursive: true }); } };
}

test("서버 버전·채널·저장과 로컬 확인의 새 버전·최신·실패를 PWA와 구분한다", async ({ page }) => {
    const initial = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
    const fixture = localSource(initial);
    try {
        fixture.manifest("stable", "9999.0.0");
        await login(page);
        let panel = await open(page);
        await expect(panel.getByTestId("server-update-version")).toContainText(initial.server.version);
        await expect(panel).toContainText("서버 protocol");
        await expect(panel).toContainText(`DB schema${initial.server.schema}`);
        await expect(panel.getByRole("combobox", { name: "자동 적용 범위", exact: true })).toHaveAttribute("data-selected-value", "notify_only");
        await expect(panel).toContainText("설정만 저장 · 설치·재시작 없음");
        await panel.getByRole("button", { name: "서버 업데이트 확인", exact: true }).click();
        await expect(panel.getByTestId("server-update-check-result")).toContainText("새 서버 버전 9999.0.0");
        fixture.manifest("stable", initial.server.version);
        await panel.getByRole("button", { name: "서버 업데이트 확인", exact: true }).click();
        await expect(panel.getByTestId("server-update-check-result")).toContainText("최신 버전");
        writeFileSync(join(fixture.root, "stable.json"), "invalid fixture");
        await panel.getByRole("button", { name: "서버 업데이트 확인", exact: true }).click();
        await expect(panel.getByTestId("server-update-check-result")).toContainText("확인 실패");
        await selectChoice(panel.getByLabel("업데이트 채널", { exact: true }), "beta");
        await selectChoice(panel.getByLabel("자동 적용 범위", { exact: true }), "patch");
        await expect(panel).toContainText("서버에 저장됨");
        fixture.manifest("beta", "9999.1.0-beta.1");
        await panel.getByRole("button", { name: "서버 업데이트 확인", exact: true }).click();
        await expect(panel.getByTestId("server-update-check-result")).toContainText("새 서버 버전 9999.1.0-beta.1");
        await expect(panel).toContainText("설치·재시작 없음");
        await page.reload();
        await openSettings(page);
        await page.getByLabel("설정 검색").last().fill("서버 업데이트");
        panel = page.getByTestId("server-update-settings").last();
        await expect(panel.getByRole("combobox", { name: "업데이트 채널", exact: true })).toHaveAttribute("data-selected-value", "beta");
        await expect(panel.getByRole("combobox", { name: "자동 적용 범위", exact: true })).toHaveAttribute("data-selected-value", "patch");
        await expect(panel.getByTestId("server-update-check-result")).toContainText("9999.1.0-beta.1");
    } finally {
        const current = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
        await apiCall("PUT", "/updates/settings", { channel: initial.settings.channel, auto_apply: initial.settings.auto_apply, expected_revision: current.settings.revision });
        fixture.close();
    }
});

test("일반 기기는 결과를 읽되 변경·확인 요청은 서버에서도 거부한다", async ({ page, request }) => {
    const device = await apiCall<{ id: string; token: string }>("POST", "/devices", { name: "update-settings-read-only" });
    try {
        const headers = { authorization: `Bearer ${device.token}`, "idempotency-key": "update-settings-device-denied" };
        const read = await request.get("/api/v1/updates/settings", { headers });
        expect(read.status()).toBe(200);
        const status = await read.json() as ServerUpdateStatus;
        expect(status.can_manage).toBe(false);
        expect((await request.put("/api/v1/updates/settings", { headers, data: {
            channel: "beta", auto_apply: "minor", expected_revision: status.settings.revision,
        } })).status()).toBe(403);
        expect((await request.post("/api/v1/updates/check", { headers, data: { expected_revision: status.settings.revision } })).status()).toBe(403);
        await page.goto("/");
        await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
        await page.getByLabel("토큰").fill(device.token);
        await page.getByRole("button", { name: "로그인", exact: true }).click();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        const panel = await open(page);
        await expect(panel).toContainText("읽기 전용");
        await expect(panel.getByRole("combobox", { name: "업데이트 채널", exact: true })).toBeDisabled();
        await expect(panel.getByRole("button", { name: "서버 업데이트 확인", exact: true })).toBeDisabled();
    } finally { await apiCall("DELETE", `/devices/${device.id}`); }
});

test("활성 작업 readiness fixture는 적용 보류 이유를 보여 준다", async ({ page }) => {
    await page.route("**/api/v1/updates/settings", async (route) => {
        const response = await route.fetch();
        const body = await response.json() as ServerUpdateStatus;
        await route.fulfill({ response, json: {
            ...body, readiness: { idle: false, busy: { active_turns: 2, running_tasks: 1, awaiting_approval: 1 } },
        } });
    });
    await login(page);
    const panel = await open(page);
    await expect(panel).toContainText("적용 보류");
    const busy = panel.getByLabel("업데이트 보류 대상").getByRole("definition").filter({ hasText: /^2$/ });
    await expect(busy).toHaveCount(1);
    await expect(panel).toContainText("실행·대기 턴");
    await expect(panel).toContainText("승인 대기");
    await expect(panel).toContainText("설치·재시작 없음");
});

test("저장 응답 유실은 같은 키로 확인하고 revision 충돌에는 초안을 유지한다", async ({ page }) => {
    const initial = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
    try {
        await login(page);
        const panel = await open(page);
        const target = initial.settings.channel === "stable" ? "beta" : "stable";
        await page.route("**/api/v1/updates/settings", async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            await route.fetch();
            await route.abort("failed");
        }, { times: 1 });
        await selectChoice(panel.getByLabel("업데이트 채널", { exact: true }), target);
        await expect(panel).toContainText("결과 불명");
        await panel.getByRole("button", { name: "같은 업데이트 요청 확인", exact: true }).click();
        await expect(panel).toContainText("서버에 저장됨");
        const saved = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
        expect(saved.settings.revision).toBe(initial.settings.revision + 1);
        await page.route("**/api/v1/updates/settings", async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            await apiCall("PUT", "/updates/settings", { channel: target, auto_apply: "patch", expected_revision: saved.settings.revision });
            await route.continue();
        }, { times: 1 });
        await selectChoice(panel.getByLabel("자동 적용 범위", { exact: true }), "minor");
        await expect(panel.getByRole("alert")).toContainText("다른 요청으로 변경");
        await expect(panel.getByRole("combobox", { name: "자동 적용 범위", exact: true })).toHaveAttribute("data-selected-value", "minor");
    } finally {
        const current = await apiCall<ServerUpdateStatus>("GET", "/updates/settings");
        await apiCall("PUT", "/updates/settings", { channel: initial.settings.channel, auto_apply: initial.settings.auto_apply, expected_revision: current.settings.revision });
    }
});
