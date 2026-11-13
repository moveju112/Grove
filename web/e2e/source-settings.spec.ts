import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, state } from "./helpers";

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
        env: { FIXTURE: "source-private-marker" }, hooks: { Stop: "source-private-marker" },
    });
    writeFileSync(join(root, ".claude/settings.json"), original);
    writeFileSync(join(root, ".codex/config.toml"), 'private = "source-private-marker"');
    const item = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    return { ...item, root, original };
}

test("프로젝트 설정은 실제 인증 API에서 안전한 원본 정보만 표시한다", async ({ page }) => {
    const item = await project();
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: item.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("원본");
    const panel = page.getByTestId("source-settings");
    const source = panel.getByRole("region", { name: "Claude · 프로젝트 원본", exact: true });
    await expect(source).toContainText("13일");
    await expect(panel).toContainText("원본을 조회했다고 Grove에 적용된 것은 아닙니다");
    await expect(panel).toContainText("미지원 형식(TOML)");
    await expect(panel).not.toContainText("source-private-marker");
    await expect(panel).not.toContainText(item.root);
    await expect(panel.locator("input, textarea, select")).toHaveCount(0);
    expect(readFileSync(join(item.root, ".claude/settings.json"), "utf8")).toBe(item.original);

    writeFileSync(join(item.root, ".claude/settings.json"), "source-private-marker malformed");
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(source.getByRole("alert")).toContainText("올바른 JSON이 아니어서");
    await expect(panel).not.toContainText("source-private-marker");
    writeFileSync(join(item.root, ".claude/settings.json"), '{"cleanupPeriodDays":17}');
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(source).toContainText("17일");
});

test("원본 API는 인증·소유자 경계를 지키고 root 입력과 다른 프로젝트 접근을 거부한다", async ({ request }) => {
    const a = await project();
    const b = await project();
    const base = "http://127.0.0.1:17741/api/v1";
    const owner = { authorization: `Bearer ${state().token}` };
    const device = await apiCall<{ id: string; token: string }>("POST", "/devices", { name: "source-settings-fixture" });
    try {
        for (const suffix of ["", `?project_id=${a.id}`, `?project_id=${b.id}`]) {
            expect((await request.get(`${base}/source-settings${suffix}`)).status()).toBe(401);
            expect((await request.get(`${base}/source-settings${suffix}`, {
                headers: { authorization: `Bearer ${device.token}` },
            })).status()).toBe(403);
        }
        const response = await request.get(`${base}/source-settings?project_id=${a.id}&root=source-private-marker`, { headers: owner });
        expect(response.status()).toBe(400);
        expect(await response.text()).not.toContain("source-private-marker");
        const unknown = await request.get(`${base}/source-settings?project_id=unregistered`, { headers: owner });
        expect(unknown.status()).toBe(404);
        const safe = await request.get(`${base}/source-settings?project_id=${a.id}`, { headers: owner });
        expect(safe.status()).toBe(200);
        expect(await safe.json()).toEqual({ items: [
            { source: "claude_project", status: "present", projection: { autoMemoryEnabled: true, cleanupPeriodDays: 13 }, ignored_invalid_fields: false },
            { source: "claude_project_local", status: "missing" },
            { source: "codex_project", status: "unsupported_format", format: "toml" },
        ] });
    } finally {
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});

test("조회 실패 화면은 서버 오류 본문을 숨기고 다시 조회할 수 있다", async ({ page }) => {
    const item = await project();
    await page.route("**/api/v1/source-settings?*", (route) => route.fulfill({
        status: 500, contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "source-private-marker" } }),
    }));
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: item.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("원본");
    const panel = page.getByTestId("source-settings");
    await expect(panel.getByRole("alert")).toContainText("원본 출처 목록을 가져오지 못했습니다");
    await expect(panel).not.toContainText("source-private-marker");
    await page.unroute("**/api/v1/source-settings?*");
    await panel.getByRole("button", { name: "원본 출처 다시 조회", exact: true }).click();
    await expect(panel).toContainText("13일");
});
