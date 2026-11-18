import { expect, test } from "@playwright/test";
import { apiCall, login, openSettings } from "./helpers";
import type { DefinitionDetail } from "../app/api/generated";

test("정의 본문은 blur 때 저장하고 기본값 복원 없이 새로고침 뒤에도 남는다", async ({ page }) => {
    const id = `autosave-${Date.now()}`;
    const definition = await apiCall<DefinitionDetail>("POST", "/definitions/agent", { id, name: id, body: "before" });
    try {
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("위임 에이전트");
        await page.getByTestId("definition-list").getByRole("button", { name: new RegExp(id) }).click();
        const editor = page.getByTestId("definition-editor");
        const body = editor.getByLabel("정의 본문", { exact: true });
        await body.fill("after");
        expect((await apiCall<DefinitionDetail>("GET", `/definitions/agent/${id}`)).body).toBe(definition.body);
        await body.blur();
        await expect(editor).toContainText("저장됨");
        expect((await apiCall<DefinitionDetail>("GET", `/definitions/agent/${id}`)).body).toBe("after");
        await expect(editor.getByRole("button", { name: /저장|기본값.*적용|기본값.*비교/ })).toHaveCount(0);
        await page.reload();
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("위임 에이전트");
        await page.getByTestId("definition-list").getByRole("button", { name: new RegExp(id) }).click();
        await expect(body).toHaveValue("after");
    } finally {
        const current = await apiCall<DefinitionDetail>("GET", `/definitions/agent/${id}`);
        await apiCall("DELETE", `/definitions/agent/${id}?expected_revision=${current.revision}`);
    }
});
