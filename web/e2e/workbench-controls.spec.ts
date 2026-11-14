import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, ensureProjects, inputOptions, login, openDetails, openTool } from "./helpers";

for (const width of [390, 1528]) {
    test.describe(`${width}px 작업 화면`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760, colorScheme: "dark" });

        test("프로젝트 도구를 탭으로 전환해도 초안과 편집 중인 스크립트를 유지한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            await ensureProfile();
            const projectData = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
            const filename = `dock-buffer-${width}.txt`;
            writeFileSync(join(projectData.root_path, filename), "저장된 파일");
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
            const project = page.locator(".project-view").filter({ visible: true });
            const input = project.getByLabel("메시지 입력", { exact: true });
            await input.fill("아직 보내지 않은 초안");
            await expect(project.getByText("드래그가 안 되면", { exact: false })).toHaveCount(0);
            await expect(project.getByText("일반 첨부에는 파일 시스템 접근 API가 필요하지 않습니다.", { exact: false })).toHaveCount(0);
            await expect(project.getByTestId("project-scripts")).toBeHidden();
            // 도구 탭은 기본 화면에 없고, 헤더의 버튼 하나로 연다.
            const trigger = project.locator(".view-head").getByRole("button", { name: "도구 패널", exact: true });
            await expect(project.getByRole("tablist", { name: "프로젝트 도구" })).toBeHidden();
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await trigger.click();
            await expect(trigger).toHaveAttribute("aria-expanded", "true");
            await project.getByRole("tab", { name: "파일", exact: true }).click();
            const files = project.getByTestId("files-view");
            await files.getByRole("button", { name: filename, exact: true }).click();
            await files.getByLabel("파일 내용", { exact: true }).fill("아직 저장하지 않은 파일");
            await project.getByRole("tab", { name: "스크립트", exact: true }).click();
            await expect(files.getByTestId("file-watch-status")).toContainText("변경 확인 일시정지");
            const scripts = project.getByTestId("project-scripts");
            await scripts.getByRole("button", { name: "script 추가", exact: true }).click();
            await scripts.getByLabel("script 이름", { exact: true }).fill("미저장 스크립트");
            for (const name of ["변경", "터미널", "파일", "예약", "워크스페이스", "휴지통", "스크립트"]) {
                const tab = project.getByRole("tab", { name, exact: true });
                await tab.click();
                await expect(tab).toHaveAttribute("aria-selected", "true");
                await expect(project.getByRole("tabpanel")).toHaveCount(1);
            }
            await expect(scripts.getByLabel("script 이름", { exact: true })).toHaveValue("미저장 스크립트");
            await expect(files.getByLabel("파일 내용", { exact: true })).toHaveValue("아직 저장하지 않은 파일");
            await project.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
            await expect(trigger).toBeFocused();
            await expect(input).toHaveValue("아직 보내지 않은 초안");
            // 다시 열면 마지막 도구로 돌아간다.
            await trigger.click();
            await expect(project.getByRole("tab", { name: "스크립트", exact: true })).toHaveAttribute("aria-selected", "true");
            await project.getByRole("tab", { name: "변경", exact: true }).click();
            await project.getByRole("tab", { name: "변경", exact: true }).focus();
            await page.keyboard.press("ArrowRight");
            await expect(project.getByRole("tab", { name: "터미널", exact: true })).toHaveAttribute("aria-selected", "true");
            await project.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
            await page.screenshot({ path: info.outputPath("project.png") });
            await openTool(project, "변경");
            await page.screenshot({ path: info.outputPath("project-tools.png") });
            expect(await project.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        });

        test("입력 옵션·첨부 버튼과 검색 대화상자가 키보드·터치로 동작한다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const title = `작업 화면 ${width} ${Date.now()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", `/sessions/${session.id}/messages`, { text: "작업 화면 확인" });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
            const view = page.getByTestId("session-view").filter({ visible: true });
            await inputOptions(view);
            await view.getByLabel("보내기 방식", { exact: true }).selectOption("save");
            await page.keyboard.press("Escape");
            await view.getByLabel("메시지 입력", { exact: true }).fill("새 메시지");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            await expect(view.getByTestId("msg-user").last()).toContainText("새 메시지");
            const chooser = page.waitForEvent("filechooser");
            await view.getByRole("button", { name: "파일 첨부", exact: true }).click();
            await (await chooser).setFiles({ name: "example.txt", mimeType: "text/plain", buffer: Buffer.from("첨부 확인") });
            await expect(view.getByLabel("선택한 첨부파일")).toContainText("example.txt");
            await openTool(view, "작업");
            await expect(view.getByLabel("백그라운드 명령")).toBeVisible();
            await page.screenshot({ path: info.outputPath("session-tools.png") });
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            const search = page.getByTestId("search-panel");
            await openDetails(search);
            const dialog = page.getByRole("dialog", { name: "대화 검색", exact: true });
            await dialog.getByRole("searchbox", { name: "대화 검색어", exact: true }).fill(title);
            await expect(dialog.getByTestId("search-hit").first()).toBeVisible();
            await dialog.getByRole("button", { name: "닫기", exact: true }).focus();
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await expect(search.getByRole("button", { name: "대화 검색", exact: true })).toBeFocused();
        });
    });
}
