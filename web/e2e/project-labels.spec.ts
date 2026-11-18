import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, selectChoice } from "./helpers";

type L = { id: string; name: string; revision: number };

// PROJECT-008: 라벨 하위 메뉴에서 만들기·다중 할당·필터(라벨 없음 포함)·이름/색 수정·충돌 오류·삭제 영향 확인.
test("Label 하위 메뉴에서 라벨을 붙이고 거르며 고치고 지운다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    const suffix = Date.now().toString(36);
    const urgent = `급함${suffix}`, front = `화면${suffix}`;
    try {
        await login(page);
        const side = page.getByTestId("sidebar").getByTestId("projects");
        const row = (name: string) => side.getByTestId("project-row").filter({ hasText: name }).first();
        const projectButton = row(a.name).getByRole("button", { name: new RegExp(a.name) }).first();

        // Label 하위 메뉴에서 새 라벨 만들고 붙이기
        await row(a.name).getByRole("button", { name: "프로젝트 메뉴" }).click();
        const menu = page.getByRole("dialog", { name: `${a.name} 메뉴` });
        await expect(menu.getByRole("button", { name: "+ 새 라벨" })).toBeHidden();
        await menu.getByRole("button", { name: "Label", exact: true }).click();
        await menu.getByRole("button", { name: "+ 새 라벨" }).click();
        await menu.getByLabel("새 라벨 이름").fill(urgent);
        await selectChoice(menu.getByLabel("라벨 색"), "red");
        await menu.getByRole("button", { name: "만들고 붙이기" }).click();
        await expect(projectButton.getByTestId(`label-chip-${urgent}`)).toBeVisible();
        await expect(menu.getByTestId(`label-assign-${urgent}`)).toHaveAttribute("aria-checked", "true");
        await menu.getByTestId(`label-assign-${urgent}`).click();
        await expect(menu.getByTestId(`label-assign-${urgent}`)).toHaveAttribute("aria-checked", "false");
        await expect(projectButton.getByTestId(`label-chip-${urgent}`)).toHaveCount(0);
        await menu.getByTestId(`label-assign-${urgent}`).click();
        await expect(menu.getByTestId(`label-assign-${urgent}`)).toHaveAttribute("aria-checked", "true");
        // 같은 이름(대소문자·공백 무시)은 거절하고 입력을 보존한다
        await menu.getByRole("button", { name: "+ 새 라벨" }).click();
        await menu.getByLabel("새 라벨 이름").fill(` ${urgent} `);
        await menu.getByRole("button", { name: "만들고 붙이기" }).click();
        await expect(page.getByRole("dialog", { name: "Label", exact: true }).getByRole("alert")).toContainText("같은 이름");
        await expect(menu.getByLabel("새 라벨 이름")).toHaveValue(` ${urgent} `);
        await menu.getByLabel("새 라벨 이름").fill(front);
        await menu.getByRole("button", { name: "만들고 붙이기" }).click();
        await expect(projectButton.getByTestId(`label-chip-${front}`)).toBeVisible();
        await page.keyboard.press("Escape");
        await menu.getByRole("button", { name: "닫기" }).click();

        // 필터: 라벨 하나, 라벨 없음, 해제. 필터는 새로고침 뒤에도 유지된다
        await side.getByRole("button", { name: "프로젝트 목록 옵션", exact: true }).click();
        await side.getByRole("button", { name: "라벨 필터" }).click();
        await side.getByTestId(`label-filter-${urgent}`).click();
        await expect(row(a.name)).toBeVisible();
        await expect(side.getByTestId("project-row").filter({ hasText: b.name })).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId("sidebar").getByTestId("projects").getByTestId(`label-filter-${urgent}`)).toHaveAttribute("aria-checked", "true");
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
        await selectChoice(editFront.getByLabel("라벨 색"), "amber");
        await editFront.getByRole("button", { name: "저장" }).click();
        await expect(projectButton.getByTestId(`label-chip-${renamed}`)).toBeVisible();

        // 삭제는 영향받는 프로젝트 수를 확인한 뒤 할당과 함께 지운다
        const editUrgent = side.getByRole("form", { name: `${urgent} 라벨 편집` });
        await editUrgent.getByRole("button", { name: "삭제" }).click();
        await expect(editUrgent.getByRole("alert")).toContainText("프로젝트 1개");
        await editUrgent.getByRole("button", { name: "삭제 확인" }).click();
        await expect(row(a.name).getByTestId(`label-chip-${urgent}`)).toHaveCount(0);
        await expect(side.getByTestId(`label-filter-${urgent}`)).toHaveCount(0);
    } finally {
        const labels = await apiCall<L[]>("GET", "/labels");
        for (const l of labels.filter((x) => x.name.endsWith(suffix))) await apiCall("DELETE", `/labels/${l.id}?expected_revision=${l.revision}`);
    }
});
