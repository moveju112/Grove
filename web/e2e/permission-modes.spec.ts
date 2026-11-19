import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallRow } from "../app/api/generated";
import { apiCall, login, openProjectSettings, requireToolApproval, selectChoice, sessionView, state } from "./helpers";

type Effective = { items: { key: string; effective: unknown; layers: Record<string, { value: unknown; revision: number }> }[] };
async function allowSetting() {
    return (await apiCall<Effective>("GET", "/settings/effective")).items.find((item) => item.key === "tools.allow")!;
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 영구 승인·bypass`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
        test("항상 승인은 저장·해제할 수 있고 bypass 선택은 즉시 적용된다", async ({ page }, info) => {
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                root_path: mkdtempSync(join(state().projA, "permissions-")),
            });
            await requireToolApproval(project.id);
            const original = await allowSetting();
            const originalValue = original.layers.server!.value;
            try {
                // 다른 시험의 사전 허용과 무관하게 write 승인을 명시적으로 준비한다.
                await apiCall("PUT", "/settings/server/-/tools.allow", {
                    expected_revision: original.layers.server!.revision,
                    value: String(originalValue ?? "").split(",").filter((name) => name.trim() !== "write").join(","),
                });
                const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `영구 승인 ${width}` });
                const call = await apiCall<ToolCallRow>("POST", `/sessions/${session.id}/tool-requests`, {
                    name: "write", args: { path: "always.txt", content: "fixture" },
                });
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
                await login(page);
                if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`^영구 승인 ${width}`) }).click();
                const view = sessionView(page, session.id);
                const card = view.getByTestId("approval");
                await expect(card).toContainText("모든 프로젝트·대화");
                await expect(card.getByRole("button", { name: "항상 승인", exact: true })).toBeEnabled();
                await page.screenshot({ path: info.outputPath("always-approval.png") });
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                await card.getByRole("button", { name: "항상 승인", exact: true }).click();
                await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("succeeded");
                expect(String((await allowSetting()).effective)).toContain("write");
                const other = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, {});
                const next = await apiCall<ToolCallRow>("POST", `/sessions/${other.id}/tool-requests`, {
                    name: "write", args: { path: "another-session.txt", content: "fixture" },
                });
                expect(next.approval_scope).toBe("policy");
                await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${next.id}`)).status).toBe("succeeded");

                await openProjectSettings(page);
                const search = page.getByLabel("설정 검색", { exact: true });
                await search.fill("승인 없이 실행할 도구");
                const allowRow = page.getByTestId("setting-tools.allow");
                await selectChoice(allowRow.getByLabel("승인 없이 실행할 도구 적용 범위", { exact: true }), "server");
                const allowInput = allowRow.getByRole("textbox", { name: "승인 없이 실행할 도구", exact: true });
                await expect(allowInput).toHaveValue(/\bwrite\b/);
                await allowInput.fill((await allowInput.inputValue()).split(",").filter((name) => name.trim() !== "write").join(","));
                await allowInput.blur();
                await expect(allowRow).toContainText("저장됨");
                const revoked = await apiCall<ToolCallRow>("POST", `/sessions/${other.id}/tool-requests`, {
                    name: "write", args: { path: "revoked.txt", content: "fixture" },
                });
                expect(revoked.status).toBe("pending_approval");
                await search.fill("도구 실행 모드");
                const row = page.getByTestId("setting-tools.mode");
                await selectChoice(row.getByLabel("도구 실행 모드", { exact: true }), "bypass");
                await expect(row).toContainText("저장됨");
                await expect(row).toContainText("확인 없이 허용");
                await expect(row).toContainText("PC 제어·위임의 별도 정책은 유지");
                const effective = await apiCall<Effective>("GET", `/settings/effective?project_id=${project.id}`);
                expect(effective.items.find((item) => item.key === "tools.mode")!.effective).toBe("bypass");
                await page.screenshot({ path: info.outputPath("bypass-settings.png") });
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                const bypass = await apiCall<ToolCallRow>("POST", `/sessions/${other.id}/tool-requests`, {
                    name: "write", args: { path: "bypass.txt", content: "fixture" },
                });
                expect(bypass.approval_scope).toBe("policy");
                await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${bypass.id}`)).status).toBe("succeeded");
            } finally {
                const current = await allowSetting();
                await apiCall("PUT", "/settings/server/-/tools.allow", {
                    expected_revision: current.layers.server!.revision, value: originalValue,
                });
            }
        });
    });
}
