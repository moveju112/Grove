import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";

// DESIGN.md "빈 대화 화면": 보조 기능은 깊이로 숨기고, 기본 화면은 위치 한 줄·입력창·빈 본문만 남긴다.
// 버튼을 다시 늘어놓는 변경이 들어오면 이 시험이 막는다.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("모바일 빈 프로젝트는 상단 한 줄·입력창만 보이고 보조 기능은 한 단계 안에 있다", async ({ page }, info) => {
    const root = mkdtempSync(join(dirname(state().projA), "empty-chat-"));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await login(page);
    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    const view = page.locator(".project-view").filter({ visible: true });
    const composer = view.locator(".composer");
    await expect(composer).toBeVisible();

    // 현재 위치는 별도 줄이 아니라 상단 바 안에 있고, 단일 탭 줄은 숨긴다.
    const topbar = page.locator(".topbar");
    // 프로젝트 화면에서는 제목이 위치를 보여 주므로 상단 바에 이름을 반복하지 않는다(보조 기술용 위치는 유지).
    const nav = page.getByTestId("navigation-context");
    await expect(topbar.getByTestId("navigation-context")).toHaveCount(1);
    await expect(nav.locator('[aria-current="page"]')).toHaveText(project.name);
    const shownNames = await page.getByText(project.name, { exact: true }).evaluateAll((nodes) =>
        nodes.filter((node) => node.getBoundingClientRect().width > 2).length);
    expect(shownNames).toBe(1);
    await expect(page.locator(".tabbar").filter({ visible: true })).toHaveCount(0);

    // 도구 탭·대화 검색·보관 필터·내부 확인 문구는 기본 화면에 없다.
    await expect(view.getByRole("tablist", { name: "프로젝트 도구" })).toBeHidden();
    await expect(view.getByRole("searchbox", { name: "대화 검색" })).toHaveCount(0);
    await expect(view.getByText("보관됨")).toHaveCount(0);
    await expect(page.getByText(/확인 중…/)).toHaveCount(0);

    // 입력창 위에 보이는 조작은 다섯 개 이하이고, 같은 이름의 진입점이 두 번 보이지 않는다.
    const composerTop = (await composer.boundingBox())!.y;
    const controls = await page.evaluate((limit) => [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")]
        .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.bottom <= limit && getComputedStyle(node).visibility !== "hidden";
        })
        .map((node) => node.getAttribute("aria-label") || node.textContent?.trim() || node.getAttribute("title") || ""), composerTop);
    expect(controls.length, controls.join(", ")).toBeLessThanOrEqual(5);
    expect(new Set(controls).size, controls.join(", ")).toBe(controls.length);

    // 입력창은 화면 아래에 붙고, 화면의 절반 이상을 빈 본문으로 남긴다.
    await page.screenshot({ path: info.outputPath("empty-project.png") });
    const headBottom = await view.locator(".view-head").evaluate((node) => node.getBoundingClientRect().bottom);
    const composerBottom = await composer.evaluate((node) => node.getBoundingClientRect().bottom);
    expect(844 - composerBottom).toBeLessThanOrEqual(32);
    expect(composerTop - headBottom).toBeGreaterThanOrEqual(844 * 0.5);

    // 숨긴 기능은 한 단계 안에서 바로 열린다.
    const trigger = view.locator(".view-head").getByRole("button", { name: "도구 패널", exact: true });
    await trigger.click();
    await expect(view.getByRole("tab", { name: "변경", exact: true })).toBeVisible();
    await view.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
    await view.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await expect(page.getByRole("button", { name: "보관된 대화 보기", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "파일 탭으로 열기", exact: true })).toBeVisible();
});
