import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallRow } from "../app/api/generated";
import { apiCall, ensureProjects, login, sessionView, state } from "./helpers";

// SessionView에서 새 ApprovalCard를 연결한 뒤 실행하는 실제 서버/브라우저 인수 시험.
async function openApproval(page: Parameters<typeof login>[0]) {
    const { a } = await ensureProjects();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `승인 표현 ${test.info().testId}` });
    const path = `approval-presentation-${session.id}.txt`;
    const call = await apiCall<ToolCallRow>("POST", `/sessions/${session.id}/tool-requests`, {
        name: "write", args: { path, content: "approval-private-content" },
    });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: `승인 표현 ${test.info().testId}` }).click();
    const card = sessionView(page, session.id).getByTestId("approval");
    await expect(card).toHaveAttribute("data-approval-id", call.id);
    return { card, call, path };
}

test("대상·부작용·넓은 허용 범위를 읽고 키보드로 거부하면 파일이 생기지 않는다", async ({ page }) => {
    const { card, call, path } = await openApproval(page);
    await expect(card.getByTestId("approval-target")).toContainText(path);
    await expect(card.getByTestId("approval-effect")).toContainText("쓰기");
    await expect(card.getByTestId("approval-allowed-scope")).toContainText("위 대상에만 한정되지 않습니다");
    await expect(card).not.toContainText("approval-private-content");
    const deny = card.getByRole("button", { name: "거부", exact: true });
    await deny.focus();
    await expect(deny).toBeFocused();
    await deny.press("Enter");
    await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("denied");
    expect(existsSync(join(state().projA, path))).toBe(false);
});

test("응답 대기 중 승인·거부를 잠가 요청을 중복 전송하지 않는다", async ({ page }) => {
    const { card, call } = await openApproval(page);
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => { release = resolve; });
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => { arrived = resolve; });
    let requests = 0;
    await page.route(`**/api/v1/tool-calls/${call.id}/decision`, async (route) => {
        requests++;
        arrived();
        await responseGate;
        await route.continue();
    });
    try {
        await card.getByRole("button", { name: "거부", exact: true }).click();
        await requestArrived;
        await expect(card.getByTestId("approval-status")).toContainText("처리 중");
        for (const name of ["이번만 승인", "이 대화에서 계속 허용", "거부"]) {
            await expect(card.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        expect(requests).toBe(1);
    } finally {
        release();
    }
    await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("denied");
});

test("권한 거부는 성공이 아니며 버튼을 다시 누를 수 없다", async ({ page }) => {
    const { card, call, path } = await openApproval(page);
    await page.route(`**/api/v1/tool-calls/${call.id}/decision`, (route) => route.fulfill({
        status: 403, contentType: "application/json",
        body: JSON.stringify({ error: { code: "forbidden", message: "private-error-content", retryable: false } }),
    }));
    await card.getByRole("button", { name: "이번만 승인", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("권한");
    await expect(card).not.toContainText("private-error-content");
    await expect(card.getByRole("button", { name: "이번만 승인", exact: true })).toBeDisabled();
    expect((await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("pending_approval");
    expect(existsSync(join(state().projA, path))).toBe(false);
    await apiCall("POST", `/tool-calls/${call.id}/decision`, { decision: "deny", expected_revision: call.revision });
});

test("전송 오류는 결과 불명으로 알리고 재승인하지 않는다", async ({ page }) => {
    const { card, call, path } = await openApproval(page);
    let requests = 0;
    await page.route(`**/api/v1/tool-calls/${call.id}/decision`, async (route) => {
        requests++;
        await route.abort("failed");
    });
    await card.getByRole("button", { name: "이번만 승인", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("결과가 불명");
    await expect(card.getByRole("button", { name: "이번만 승인", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "거부", exact: true })).toBeDisabled();
    expect(requests).toBe(1);
    expect(existsSync(join(state().projA, path))).toBe(false);
    await page.route(`**/api/v1/tool-calls/${call.id}`, (route) => route.fulfill({
        status: 503, contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable", message: "private-refresh-error", retryable: true } }),
    }));
    await card.getByRole("button", { name: "최신 상태 확인", exact: true }).click();
    await expect(card.getByRole("alert").filter({ hasText: "최신 상태를 가져오지 못했습니다" })).toBeVisible();
    await expect(card).not.toContainText("private-refresh-error");
    expect(requests).toBe(1);
    await apiCall("POST", `/tool-calls/${call.id}/decision`, { decision: "deny", expected_revision: call.revision });
});
