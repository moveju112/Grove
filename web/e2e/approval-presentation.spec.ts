import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallRow } from "../app/api/generated";
import { apiCall, ensureProjects, login, requireToolApproval, sessionView, state } from "./helpers";

// SessionView에서 새 ApprovalCard를 연결한 뒤 실행하는 실제 서버/브라우저 인수 시험.
async function openApproval(page: Parameters<typeof login>[0], history = 0) {
    const { a } = await ensureProjects();
    await requireToolApproval(a.id);
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `승인 표현 ${test.info().testId}` });
    for (let i = 0; i < history; i++) {
        await apiCall("POST", `/sessions/${session.id}/messages`, { text: `이전 대화 ${i}\n${"승인 카드 위에 쌓이는 본문입니다. ".repeat(12)}` });
    }
    const path = `approval-presentation-${session.id}.txt`;
    const call = await apiCall<ToolCallRow>("POST", `/sessions/${session.id}/tool-requests`, {
        name: "write", args: { path, content: "approval-private-content" },
    });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: `승인 표현 ${test.info().testId}` }).click();
    const view = sessionView(page, session.id);
    const card = view.getByTestId("approval");
    await expect(card).toHaveAttribute("data-approval-id", call.id);
    return { card, call, path, view };
}

test("대상·부작용·넓은 허용 범위를 읽고 키보드로 거부하면 파일이 생기지 않는다", async ({ page }) => {
    const { card, call, path, view } = await openApproval(page);
    const approval = (await card.boundingBox())!;
    const composer = (await view.getByTestId("composer").boundingBox())!;
    expect(approval.x).toBeCloseTo(composer.x, 0);
    expect(approval.width).toBeCloseTo(composer.width, 0);
    await expect(card.getByTestId("approval-target")).toContainText(path);
    await expect(card.getByTestId("approval-effect")).toContainText("생성·수정·삭제");
    await expect(card.getByTestId("approval-allowed-scope")).toContainText("도구 전체에 적용됩니다");
    await expect(card).not.toContainText("approval-private-content");
    const deny = card.getByRole("button", { name: "거부", exact: true });
    await deny.focus();
    await expect(deny).toBeFocused();
    await deny.press("Enter");
    await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("denied");
    expect(existsSync(join(state().projA, path))).toBe(false);
});

test("오프라인에서는 승인·거부를 잠그고 복구 후에도 자동으로 실행하지 않는다", async ({ page }) => {
    const { card, call, path } = await openApproval(page);
    await expect(card.getByRole("button", { name: "이번만 승인", exact: true })).toBeEnabled();
    let decisions = 0;
    page.on("request", (request) => {
        if (request.url().endsWith(`/tool-calls/${call.id}/decision`)) decisions++;
    });
    try {
        await page.context().setOffline(true);
        for (const name of ["이번만 승인", "이 대화에서 승인", "항상 승인", "거부"]) {
            await expect(card.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        await expect(card.getByTestId("approval-status")).toContainText("오프라인");
    } finally {
        await page.context().setOffline(false);
    }
    await expect(card.getByRole("button", { name: "이번만 승인", exact: true })).toBeEnabled();
    expect(decisions).toBe(0);
    expect((await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("pending_approval");
    expect(existsSync(join(state().projA, path))).toBe(false);
    await card.getByRole("button", { name: "거부", exact: true }).click();
    await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("denied");
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
        for (const name of ["이번만 승인", "이 대화에서 승인", "항상 승인", "거부"]) {
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

test("화면이 낮아도 맨 아래 고정은 승인 카드를 입력창 뒤로 밀지 않는다", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    const { card, view } = await openApproval(page, 6);
    const surface = view.getByTestId("compose-surface");
    const approve = card.getByRole("button", { name: "이번만 승인", exact: true });
    const covered = async () => {
        const button = (await approve.boundingBox())!;
        return button.y + button.height - (await surface.boundingBox())!.y;
    };
    await expect.poll(covered).toBeLessThanOrEqual(0);
    await page.mouse.move(640, 100);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(1500);
    expect(await covered()).toBeLessThanOrEqual(0);
});
