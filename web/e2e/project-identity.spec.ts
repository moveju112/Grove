import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, expectChoice, login, selectChoice } from "./helpers";

// PROJECT-002: 프로젝트 아이콘·이름 변경과 기기별 정렬(이름순·최근 활동순).
test("프로젝트 아이콘을 바꾸고 최근 활동순 정렬이 새로고침 뒤에도 유지된다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    await login(page);
    const side = page.getByTestId("sidebar").getByTestId("projects");
    await side.getByRole("button", { name: new RegExp(a.name) }).first().click();
    const head = page.getByTestId("project-view").locator("header").filter({ hasText: a.name }).first();
    await head.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await head.getByRole("button", { name: "이름·아이콘" }).click();
    const form = head.getByRole("form", { name: "프로젝트 이름·아이콘" });
    await form.getByLabel("아이콘").fill("🌿");
    await form.getByRole("button", { name: "저장" }).click();
    await expect(head.locator("h1")).toContainText("🌿");
    await expect(side.getByTestId("project-row").filter({ hasText: a.name })).toContainText("🌿");

    // 최근 활동순: 방금 대화가 생긴 프로젝트가 맨 위
    await side.getByRole("button", { name: "프로젝트 목록 옵션", exact: true }).click();
    await selectChoice(side.getByLabel("프로젝트 정렬"), "recent");
    await apiCall("POST", `/projects/${b.id}/sessions`, { title: `정렬 확인 ${Date.now()}` });
    await expect(side.getByTestId("project-row").first()).toContainText(b.name);
    await page.reload();
    await side.getByRole("button", { name: "프로젝트 목록 옵션", exact: true }).click();
    await expectChoice(page.getByTestId("sidebar").getByTestId("projects").getByLabel("프로젝트 정렬"), "recent");
    await expect(page.getByTestId("sidebar").getByTestId("projects").getByTestId("project-row").first()).toContainText(b.name);

    // 정리: 아이콘 해제
    const cur = await apiCall<{ revision: number }>("GET", `/projects/${a.id}`);
    await apiCall("PATCH", `/projects/${a.id}`, { expected_revision: cur.revision, icon: null });
});
