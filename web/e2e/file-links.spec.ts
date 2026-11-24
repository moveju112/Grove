import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView, state } from "./helpers";

for (const mobile of [false, true]) {
    test.describe(mobile ? "390px 파일 링크" : "파일 링크", () => {
        if (mobile) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

        test("파일 링크와 줄 앵커에서 변경점을 확인하고 원문으로 이동한다", async ({ page }, info) => {
            await ensureProjects();
            const profile = await ensureProfile();
            const root = mkdtempSync(join(dirname(state().projA), "file-links-"));
            const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
            git("init", "-q", "-b", "main");
            git("config", "user.email", "e2e@example.invalid");
            git("config", "user.name", "E2E");
            writeFileSync(join(root, "app.rs"), "base\n");
            mkdirSync(join(root, "hnote"));
            writeFileSync(join(root, "hnote", "DESIGN.md"), "# 데이터 보호 원칙\n\n본문 예시\n");
            git("add", "app.rs", "hnote/DESIGN.md");
            git("commit", "-qm", "base");
            writeFileSync(join(root, "app.rs"), "staged\n");
            git("add", "app.rs");
            writeFileSync(join(root, "app.rs"), "working\n찾는 줄\n");
            writeFileSync(join(root, "hnote/new notes.md"), "# 새 문서 내용\n\n화면에 보호 상태를 표시하는 기준을 정한다.\n\n## 조회와 저장\n\n- 조회만으로 저장 상태를 바꾸지 않는다.\n- 저장 결과를 확인한 뒤 화면에 반영한다.\n");
            const before = readFileSync(join(root, ".git/index"));
            const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `파일 링크 ${mobile}` });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
            const markdown = [
                "| 실제 작업 질문 | 확인 결과 |",
                "| --- | --- |",
                `| 버튼 순서는? | [데스크톱 목표 설정](<${root}/app.rs:2>) · [프로젝트 편집](<${root}/hnote/new notes.md>) |`,
                "",
                "[설계 문서](hnote/DESIGN.md) · [사라진 파일](missing.md) · `DESIGN.md`",
                "",
                `[퀴즈 통과 조건](<${root}/app.rs:2>) · [구현 코드](app.rs#L2) · [실제 닉네임으로 대화 보기](<${root}/hnote/new notes.md>) · [참고 문서](https://example.com/guide) · [외부 파일](/etc/passwd#L1) · \`app.rs:2\``,
            ].join("\n");
            await script({ frames: frames.text([markdown]) });
            const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { profile_id: profile, text: "변경 파일 보여줘" });
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
            await page.addInitScript(() => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme: "soft" })));
            await login(page);
            // 탐색 서랍은 기존 모바일 동선을 사용한다.
            if (mobile) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`파일 링크 ${mobile}`) }).first().click();
            const view = sessionView(page, session.id);
            await expect(view).toBeVisible();
            const answer = view.getByTestId("msg-assistant").last();
            await expect(answer.getByRole("button", { name: "퀴즈 통과 조건" })).toBeVisible();
            await expect(page.locator("html")).toHaveAttribute("data-theme", "soft");
            await expect(answer.getByTestId("file-link")).toHaveCount(7, { timeout: 15_000 });
            await expect(answer).not.toContainText("#L2");
            const namedButton = answer.getByRole("button", { name: "실제 닉네임으로 대화 보기", exact: true });
            const citation = answer.getByRole("cell").getByRole("button", { name: "데스크톱 목표 설정" });
            for (const button of [namedButton, citation]) {
                const caption = button.getByText(await button.innerText(), { exact: true });
                await expect(caption).toHaveCSS("text-decoration-line", "underline");
                await expect(button).toHaveCSS("border-top-width", "0px");
                const icon = await button.locator("svg").boundingBox();
                const text = await caption.boundingBox();
                expect(icon!.x + icon!.width).toBeLessThanOrEqual(text!.x);
                if (mobile) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            }
            const external = answer.getByRole("link", { name: /참고 문서/ });
            await expect(external).toHaveCSS("text-decoration-line", "underline");
            await expect(external).toContainText("↗ example.com");
            await answer.screenshot({ path: info.outputPath(`file-citation-${mobile ? 390 : "desktop"}.png`), animations: "disabled" });
            await answer.getByRole("button", { name: "사라진 파일" }).click();
            const missing = page.getByRole("dialog", { name: "missing.md 미리보기" });
            await expect(missing).toContainText("이 경로에서 파일을 찾을 수 없어요.");
            await expect(missing.getByRole("button", { name: "편집기에서 열기" })).toHaveCount(0);
            await missing.getByRole("button", { name: "닫기" }).click();
            await answer.getByRole("button", { name: "설계 문서" }).click();
            const clean = page.getByRole("dialog", { name: "hnote/DESIGN.md 미리보기" });
            await expect(clean.getByRole("heading", { name: "데이터 보호 원칙" })).toBeVisible();
            await expect(clean.getByText("hnote/DESIGN.md", { exact: true })).toBeVisible();
            await expect(clean.getByRole("tab", { name: "변경점" })).toHaveCount(0);
            await clean.getByRole("button", { name: "닫기" }).click();
            if (mobile) await citation.tap();
            else await citation.click();
            const dialog = page.getByRole("dialog", { name: "app.rs 미리보기", exact: true });
            await expect(dialog.getByRole("tabpanel", { name: "본문" })).toContainText("찾는 줄");
            await expect(dialog.getByTestId("file-diff")).toHaveCount(0);
            await dialog.getByRole("tab", { name: "변경점" }).click();
            await expect(dialog).toContainText("-base");
            await expect(dialog).toContainText("+staged");
            await expect(dialog).toContainText("+working");
            await expect(dialog).toContainText("작업 트리 변경");
            await expect(dialog).toContainText("커밋할 변경");
            await expect(dialog.getByTestId("file-diff")).toHaveCount(2);
            await expect(dialog.locator("textarea")).toHaveCount(0);
            if (mobile) await page.screenshot({ path: info.outputPath("file-link-390.png"), animations: "disabled" });
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await expect(citation).toBeFocused();
            await answer.getByTestId("file-ref").click();
            await dialog.getByRole("tab", { name: "변경점" }).click();
            await expect(dialog.getByTestId("file-diff")).toHaveCount(2);
            await expect(page.getByTestId("files-view")).toHaveCount(0);
            await dialog.getByRole("button", { name: "닫기", exact: true }).click();
            await namedButton.click();
            const newFile = page.getByRole("dialog", { name: "hnote/new notes.md 미리보기", exact: true });
            await expect(newFile.getByRole("heading", { name: "새 문서 내용" })).toBeVisible();
            await expect(newFile.getByRole("tab", { name: "본문" })).toHaveAttribute("aria-selected", "true");
            await page.screenshot({ path: info.outputPath(`file-preview-${mobile ? 390 : "desktop"}.png`), animations: "disabled" });
            await newFile.getByRole("tab", { name: "변경점" }).click();
            await expect(newFile).toContainText("새 파일");
            await expect(newFile.getByTestId("file-diff")).toContainText("@@ -0,0 +1,8 @@");
            await newFile.getByRole("button", { name: "닫기", exact: true }).click();
            writeFileSync(join(root, "app.rs"), "updated\n찾는 줄\n");
            await answer.getByRole("button", { name: "구현 코드", exact: true }).click();
            await expect(dialog).toContainText("updated");
            await dialog.getByRole("button", { name: "편집기에서 열기", exact: true }).click();
            const area = page.getByTestId("files-view").getByLabel("파일 내용");
            await expect(area).toHaveValue("updated\n찾는 줄\n");
            expect(await area.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("찾는 줄");
            expect(readFileSync(join(root, ".git/index"))).toEqual(before);
        });
    });
}
