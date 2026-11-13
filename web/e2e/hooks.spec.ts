import { expect, test, type Page } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";
import type { Hook, HookListing } from "../app/api/hooks";

async function list(projectId?: string) {
    return (await apiCall<HookListing>("GET", `/hooks${projectId ? `?project_id=${projectId}` : ""}`)).hooks;
}
async function cleanup(prefix: string, projectId?: string) {
    for (const hook of (await list(projectId)).filter((h) => h.name.startsWith(prefix))) {
        await apiCall("DELETE", `/hooks/${hook.id}?expected_revision=${hook.revision}${projectId ? `&project_id=${projectId}` : ""}`);
    }
}
async function open(page: Page) {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").last().fill("hook");
    return page.getByTestId("hooks-panel").last();
}

test("hook 추가·수정·비활성화·삭제는 미실행이며 명령의 비밀값을 표시하지 않는다", async ({ page }) => {
    const prefix = `hook-ui-${Date.now()}`;
    try {
        const panel = await open(page);
        await expect(panel).toContainText("아직 실행되지 않음");
        await panel.getByLabel("hook 이름", { exact: true }).fill(prefix);
        await panel.getByLabel("hook 이벤트", { exact: true }).selectOption("PreToolUse");
        await panel.getByLabel("hook matcher", { exact: true }).fill("shell*");
        await panel.getByLabel("hook 명령", { exact: true }).fill("TOKEN=hooks-ui-fixture-private printf not-run");
        await panel.getByLabel("hook 활성 설정 (별도 승인 필요)", { exact: true }).check();
        await panel.getByRole("button", { name: "hook 설정 저장", exact: true }).click();
        const row = panel.getByTestId("hook-row").filter({ hasText: prefix });
        await expect(row).toContainText("revision 1");
        await expect(row).toContainText("활성 설정");
        await expect(row).toContainText("[redacted]");
        await expect(panel).not.toContainText("hooks-ui-fixture-private");
        await row.getByRole("button", { name: "hook 편집", exact: true }).click();
        await panel.getByLabel("hook 이름", { exact: true }).fill(`${prefix} edited`);
        await panel.getByLabel("hook 이벤트", { exact: true }).selectOption("Stop");
        await panel.getByRole("button", { name: "hook 설정 저장", exact: true }).click();
        await expect(row).toContainText("revision 2");
        await row.getByRole("button", { name: "hook 비활성화", exact: true }).click();
        await expect(row).toContainText("비활성 설정");
        await expect(row).toContainText("revision 3");
        await page.reload();
        await page.getByLabel("설정 검색").last().fill("hook");
        await expect(row).toContainText("이벤트 발생 후 개별 승인 필요");
        await row.getByRole("button", { name: "hook 삭제 확인", exact: true }).click();
        await panel.getByRole("button", { name: "이 hook 삭제", exact: true }).click();
        await expect(row).toHaveCount(0);
    } finally { await cleanup(prefix); }
});

test("잘못된 matcher·revision 충돌은 거부하고 초안을 보존한다", async ({ page }) => {
    const prefix = `hook-conflict-${Date.now()}`;
    const definition = { name: prefix, event: "Stop", matcher: "*", command: "printf not-run", enabled: false };
    const hook = await apiCall<Hook>("POST", "/hooks", definition);
    try {
        const panel = await open(page);
        const row = panel.getByTestId("hook-row").filter({ hasText: prefix });
        await row.getByRole("button", { name: "hook 편집", exact: true }).click();
        await panel.getByLabel("hook matcher", { exact: true }).fill("[");
        await panel.getByRole("button", { name: "hook 설정 저장", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("glob");
        await expect(row).toContainText("revision 1");
        await panel.getByLabel("hook matcher", { exact: true }).fill("local*");
        await apiCall("PUT", `/hooks/${hook.id}`, { ...definition, command: undefined, matcher: "remote*", expected_revision: 1 });
        await panel.getByRole("button", { name: "hook 설정 저장", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("다른 요청으로 변경");
        await expect(panel.getByLabel("hook matcher", { exact: true })).toHaveValue("local*");
        await panel.getByRole("button", { name: "최신 hook 설정 사용", exact: true }).click();
        await expect(panel.getByLabel("hook matcher", { exact: true })).toHaveValue("remote*");
        await panel.getByRole("button", { name: "hook 편집 취소", exact: true }).click();
        await row.getByRole("button", { name: "hook 삭제 확인", exact: true }).click();
        await apiCall("PUT", `/hooks/${hook.id}`, { ...definition, command: undefined, expected_revision: 2 });
        await panel.getByRole("button", { name: "이 hook 삭제", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("다른 요청으로 변경");
        await expect(row).toHaveCount(1);
        await panel.getByRole("button", { name: "hook 삭제 취소", exact: true }).click();
    } finally { await cleanup(prefix); }
});

test("프로젝트 범위는 전역·다른 프로젝트와 분리하고 기기 토큰은 거부한다", async ({ page, request }) => {
    const prefix = `hook-scope-${Date.now()}`;
    const { a, b } = await ensureProjects();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: prefix });
    const device = await apiCall<{ id: string; token: string }>("POST", "/devices", { name: prefix });
    try {
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(prefix) }).click();
        await sessionView(page, session.id).getByRole("button", { name: "대화 설정" }).click();
        await page.getByLabel("설정 검색").last().fill("hook");
        await page.getByLabel("hook 범위", { exact: true }).selectOption("project");
        const panel = page.getByTestId("hooks-panel").last();
        await panel.getByLabel("hook 이름", { exact: true }).fill(prefix);
        await panel.getByLabel("hook 명령", { exact: true }).fill("printf project");
        await panel.getByRole("button", { name: "hook 설정 저장", exact: true }).click();
        await expect(panel.getByTestId("hook-row").filter({ hasText: prefix })).toHaveCount(1);
        expect((await list()).some((h) => h.name === prefix)).toBe(false);
        expect((await list(b.id)).some((h) => h.name === prefix)).toBe(false);
        const hook = (await list(a.id)).find((h) => h.name === prefix)!;
        const denied = await request.get(`http://127.0.0.1:17741/api/v1/hooks?project_id=${a.id}`, { headers: { authorization: `Bearer ${device.token}` } });
        expect(denied.status()).toBe(403);
        await expect(apiCall("PUT", `/hooks/${hook.id}?project_id=${b.id}`, {
            name: prefix, event: hook.event, matcher: hook.matcher, enabled: true, expected_revision: 1,
        })).rejects.toThrow("404");
        await page.getByLabel("hook 범위", { exact: true }).selectOption("global");
        await expect(panel.getByTestId("hook-row").filter({ hasText: prefix })).toHaveCount(0);
    } finally {
        await cleanup(prefix, a.id);
        await apiCall("DELETE", `/devices/${device.id}`);
    }
});

test("응답 유실 뒤 동일 키로 설정 결과를 확인하고 한 번만 저장한다", async ({ page }) => {
    const prefix = `hook-recovery-${Date.now()}`;
    try {
        const panel = await open(page);
        const requests: { key?: string; body: unknown }[] = [];
        await page.route("**/api/v1/hooks", async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
            if (requests.length === 1) { await route.fetch(); await route.abort(); }
            else await route.continue();
        });
        await panel.getByLabel("hook 이름", { exact: true }).fill(prefix);
        await panel.getByLabel("hook 명령", { exact: true }).fill("printf recovery");
        await panel.getByRole("button", { name: "hook 설정 저장", exact: true }).click();
        await expect(panel).toContainText("저장 결과 불명");
        await expect(page.getByLabel("hook 범위", { exact: true })).toBeDisabled();
        await panel.getByRole("button", { name: "같은 hook 요청 확인", exact: true }).click();
        await expect(panel).not.toContainText("저장 결과 불명");
        await expect(panel.getByTestId("hook-row").filter({ hasText: prefix })).toContainText("revision 1");
        expect(requests).toHaveLength(2);
        expect(requests[0]!.key).toBeTruthy();
        expect(requests[1]).toEqual(requests[0]);
        expect((await list()).filter((h) => h.name === prefix)).toHaveLength(1);
    } finally { await cleanup(prefix); }
});
