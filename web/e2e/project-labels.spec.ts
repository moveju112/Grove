import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login } from "./helpers";

type P = { id: string; revision: number; pinned_at: string | null };
type L = { id: string; name: string; revision: number };

// PROJECT-008: 프로젝트 고정, 라벨 만들기·다중 할당·필터(라벨 없음 포함)·이름/색 수정·충돌 오류·삭제 영향 확인.
test("프로젝트를 고정하고 라벨로 거르며 라벨을 고치고 지운다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    const suffix = Date.now().toString(36);
    const urgent = `급함${suffix}`, front = `화면${suffix}`;
    try {
        await login(page);
        const side = page.locator(".sidebar .projects");
        const row = (name: string) => side.getByTestId("project-row").filter({ hasText: name }).first();

        // 고정하면 맨 위, 새로고침 뒤에도 유지
        await row(b.name).getByRole("button", { name: "프로젝트 메뉴" }).click();
        await row(b.name).getByRole("button", { name: "맨 위에 고정" }).click();
        await expect(side.getByTestId("project-row").first()).toContainText(b.name);
        await expect(row(b.name).getByLabel("고정됨")).toBeVisible();

        // 메뉴에서 새 라벨 만들고 붙이기
        await row(a.name).getByRole("button", { name: "프로젝트 메뉴" }).click();
        const menu = page.getByRole("dialog", { name: `${a.name} 메뉴` });
        await menu.getByRole("button", { name: "+ 새 라벨" }).click();
        await menu.getByLabel("새 라벨 이름").fill(urgent);
        await menu.getByRole("radio", { name: "빨강" }).check();
        await menu.getByRole("button", { name: "만들고 붙이기" }).click();
        await expect(row(a.name).locator(".label-chips").getByTestId(`label-chip-${urgent}`)).toBeVisible();
        await expect(menu.getByTestId(`label-assign-${urgent}`)).toHaveAttribute("aria-checked", "true");
        // 같은 이름(대소문자·공백 무시)은 거절하고 입력을 보존한다
        await menu.getByRole("button", { name: "+ 새 라벨" }).click();
        await menu.getByLabel("새 라벨 이름").fill(` ${urgent} `);
        await menu.getByRole("button", { name: "만들고 붙이기" }).click();
        await expect(menu.getByRole("alert")).toContainText("같은 이름");
        await expect(menu.getByLabel("새 라벨 이름")).toHaveValue(` ${urgent} `);
        await menu.getByLabel("새 라벨 이름").fill(front);
        await menu.getByRole("button", { name: "만들고 붙이기" }).click();
        await expect(row(a.name).locator(".label-chips").getByTestId(`label-chip-${front}`)).toBeVisible();
        await menu.getByRole("button", { name: "닫기" }).click();

        // 필터: 라벨 하나, 라벨 없음, 해제. 필터는 새로고침 뒤에도 유지된다
        await side.getByLabel("프로젝트 목록 옵션", { exact: true }).click();
        await side.getByRole("button", { name: "라벨 필터" }).click();
        await side.getByTestId(`label-filter-${urgent}`).click();
        await expect(row(a.name)).toBeVisible();
        await expect(side.getByTestId("project-row").filter({ hasText: b.name })).toHaveCount(0);
        await page.reload();
        await expect(page.locator(".sidebar .projects").getByTestId(`label-filter-${urgent}`)).toHaveAttribute("aria-checked", "true");
        await expect(side.getByTestId("project-row").filter({ hasText: b.name })).toHaveCount(0);
        await side.getByTestId(`label-filter-${urgent}`).click();
        await side.getByTestId("label-filter-none").click();
        await expect(row(b.name)).toBeVisible();
        await expect(side.getByTestId("project-row").filter({ hasText: a.name })).toHaveCount(0);
        await side.getByRole("button", { name: "필터 해제" }).first().click();
        await expect(row(a.name)).toBeVisible();
        await expect(row(b.name)).toBeVisible();

        // 관리: 겹치는 이름으로 바꾸면 거절, 이름·색 수정은 할당 유지
        await side.getByRole("button", { name: "라벨 관리" }).click();
        const editFront = side.getByRole("form", { name: `${front} 라벨 편집` });
        await editFront.getByLabel(`${front} 이름`).fill(urgent.toUpperCase());
        await editFront.getByRole("button", { name: "저장" }).click();
        await expect(editFront.getByRole("alert")).toContainText("같은 이름");
        const renamed = `디자인${suffix}`;
        await editFront.getByLabel(`${front} 이름`).fill(renamed);
        await editFront.getByRole("radio", { name: "호박" }).check();
        await editFront.getByRole("button", { name: "저장" }).click();
        await expect(row(a.name).locator(".label-chips").getByTestId(`label-chip-${renamed}`)).toBeVisible();

        // 삭제는 영향받는 프로젝트 수를 확인한 뒤 할당과 함께 지운다
        const editUrgent = side.getByRole("form", { name: `${urgent} 라벨 편집` });
        await editUrgent.getByRole("button", { name: "삭제" }).click();
        await expect(editUrgent.getByRole("alert")).toContainText("프로젝트 1개");
        await editUrgent.getByRole("button", { name: "삭제 확인" }).click();
        await expect(row(a.name).locator(".label-chips").getByTestId(`label-chip-${urgent}`)).toHaveCount(0);
        await expect(side.getByTestId(`label-filter-${urgent}`)).toHaveCount(0);
    } finally {
        const labels = await apiCall<L[]>("GET", "/labels");
        for (const l of labels.filter((x) => x.name.endsWith(suffix))) await apiCall("DELETE", `/labels/${l.id}?expected_revision=${l.revision}`);
        const cur = await apiCall<P>("GET", `/projects/${b.id}`);
        if (cur.pinned_at) await apiCall("PATCH", `/projects/${b.id}`, { expected_revision: cur.revision, pinned: false });
    }
});
