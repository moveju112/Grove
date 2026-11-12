import { expect, test } from "@playwright/test";
import { apiCall, login } from "./helpers";

type Server = { id: string; name: string; config: unknown; enabled: boolean; revision: number; timeout_secs: number };

test("MCP 등록·편집·사용 설정·삭제는 실제 연결과 구분하고 secret 원문을 표시하지 않는다", async ({ page }) => {
    const name = `mcp-ui-${Date.now()}`;
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: name, value: "Bearer mcp-ui-fixture-private" });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        const panel = page.getByTestId("mcp-panel");
        await panel.getByLabel("MCP 이름", { exact: true }).fill(name);
        await panel.getByLabel("MCP 설정 JSON", { exact: true }).fill(JSON.stringify({
            transport: "http", endpoint: "https://example.com/mcp", header_secrets: { Authorization: secret.id },
        }));
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        const row = panel.getByTestId("mcp-row").filter({ hasText: name });
        await expect(row).toContainText("사용 안 함");
        await expect(panel).not.toContainText("mcp-ui-fixture-private");
        await row.getByRole("button", { name: "MCP 사용 켜기", exact: true }).click();
        await expect(row).toContainText("사용 설정 · 미연결");
        await row.getByRole("button", { name: "MCP 편집", exact: true }).click();
        await panel.getByLabel("MCP timeout(초)", { exact: true }).fill("90");
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(row).toContainText("revision 3");
        await page.reload();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        await expect(row).toContainText("사용 설정 · 미연결");
        await row.getByRole("button", { name: "MCP 사용 끄기", exact: true }).click();
        await expect(row).toContainText("사용 안 함");
        await row.getByRole("button", { name: "MCP 삭제 확인", exact: true }).click();
        await panel.getByRole("button", { name: "삭제 취소", exact: true }).click();
        await expect(row).toHaveCount(1);
        await row.getByRole("button", { name: "MCP 삭제 확인", exact: true }).click();
        await panel.getByRole("button", { name: "이 MCP 설정 삭제", exact: true }).click();
        await expect(row).toHaveCount(0);
        const secrets = await apiCall<{ id: string }[]>("GET", "/secrets");
        expect(secrets.some((s) => s.id === secret.id)).toBe(true);
    } finally {
        const list = await apiCall<Server[]>("GET", "/mcp/servers");
        for (const s of list.filter((s) => s.name === name)) await apiCall("DELETE", `/mcp/servers/${s.id}?expected_revision=${s.revision}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
    }
});

test("MCP 오래된 revision·잘못된 설정은 덮어쓰지 않고 응답 유실은 같은 키로 확인한다", async ({ page }) => {
    const name = `mcp-conflict-${Date.now()}`;
    const config = { transport: "stdio", command: "not-executed-fixture", args: [], env_secrets: {} };
    const created = await apiCall<Server>("POST", "/mcp/servers", { name, config });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        const panel = page.getByTestId("mcp-panel");
        const row = panel.getByTestId("mcp-row").filter({ hasText: name });
        await row.getByRole("button", { name: "MCP 편집", exact: true }).click();
        await panel.getByLabel("MCP timeout(초)", { exact: true }).fill("80");
        await apiCall("PUT", `/mcp/servers/${created.id}`, { expected_revision: 1, server: { name, config, timeout_secs: 70 } });
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("다른 요청으로 변경");
        await expect(panel.getByLabel("MCP timeout(초)", { exact: true })).toHaveValue("80");
        await panel.getByRole("button", { name: "최신 MCP 설정 사용", exact: true }).click();
        await panel.getByLabel("MCP 설정 JSON", { exact: true }).fill('{"transport":"stdio","command":""}');
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("실행 파일");
        await expect(row).toContainText("revision 2");
        await panel.getByLabel("MCP 설정 JSON", { exact: true }).fill(JSON.stringify(config));
        const keys: string[] = [];
        await page.route(`**/api/v1/mcp/servers/${created.id}`, async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            keys.push(route.request().headers()["idempotency-key"]!);
            const response = await route.fetch();
            if (keys.length === 1) await route.abort("connectionfailed");
            else await route.fulfill({ response });
        });
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 결과 재확인", exact: true })).toBeVisible();
        await expect(panel.getByLabel("MCP 이름", { exact: true })).toBeDisabled();
        await panel.getByRole("button", { name: "같은 MCP 요청 확인", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 결과 재확인", exact: true })).toHaveCount(0);
        await expect(row).toContainText("revision 3");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
    } finally {
        const list = await apiCall<Server[]>("GET", "/mcp/servers");
        for (const s of list.filter((s) => s.id === created.id)) await apiCall("DELETE", `/mcp/servers/${s.id}?expected_revision=${s.revision}`);
    }
});
