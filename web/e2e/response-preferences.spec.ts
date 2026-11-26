import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, choiceOptions, ensureProfile, expectChoice, login, openSettings, openProjectSettings, script, selectChoice, state } from "./helpers";
import { frames } from "./fixture";

type Item = { key: string; effective: unknown; layers: { server: { value: unknown; revision: number } } };
const keys = ["output.style"];
let saved: { key: string; value: unknown }[] = [];

async function settings() {
    return (await apiCall<{ items: Item[] }>("GET", "/settings/effective")).items;
}

test.beforeEach(async () => {
    const items = await settings();
    saved = keys.map((key) => ({ key, value: items.find((item) => item.key === key)!.layers.server.value }));
});

test.afterEach(async () => {
    for (const item of saved) {
        const current = (await settings()).find((candidate) => candidate.key === item.key)!;
        await apiCall("PUT", `/settings/server/-/${item.key}`, { expected_revision: current.layers.server.revision, value: item.value });
    }
});

for (const width of [390, 1280]) {
    test.describe(`${width}px 답변 스타일`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        test("다섯 답변 스타일을 저장해 다음 요청과 새로고침에 반영한다", async ({ page }, info) => {
            const profile = await ensureProfile();
            await login(page);
            await openSettings(page);
            await page.getByLabel("설정 검색").fill("출력 스타일");
            const style = page.getByTestId("setting-output.style");
            const choice = style.getByRole("combobox", { name: "출력 스타일", exact: true });
            await expect(await choiceOptions(choice)).toHaveText(["디폴트", "디테일", "심플", "미니멀", "익스트림 미니멀"]);
            await page.screenshot({ path: info.outputPath("output-styles.png"), animations: "disabled" });
            await page.keyboard.press("Escape");
            const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(dirname(state().projA), "response-preferences-")) });
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "response preferences fixture" });
            type Turn = { status: string; definition: { output_style: string; user_profile?: unknown; language?: unknown } };
            for (const value of ["detailed", "simple", "minimal", "extreme-minimal", "default"]) {
                await selectChoice(choice, value);
                await expect(style.getByRole("status")).toHaveText("저장됨");
                await expect(style.getByRole("status")).toHaveAccessibleDescription("다음 요청부터 적용");
                const marker = `fixture question ${value}`;
                await script({ frames: frames.text(["fixture answer"]), marker });
                const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: marker, profile_id: profile });
                await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
                const turn = await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`);
                expect(turn.definition.output_style).toBe(value);
                expect(turn.definition.user_profile).toBeUndefined();
                expect(turn.definition.language).toBeUndefined();
                await page.reload();
                await openSettings(page);
                await page.getByLabel("설정 검색").fill("출력 스타일");
                await expectChoice(choice, value);
            }
        });
    });
}

test("이전 간결하게 설정은 심플로 표시하고 새 스타일로 변경할 수 있다", async ({ page }) => {
    const current = (await settings()).find((item) => item.key === "output.style")!;
    await apiCall("PUT", "/settings/server/-/output.style", { expected_revision: current.layers.server.revision, value: "concise" });
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("출력 스타일");
    const choice = page.getByTestId("setting-output.style").getByLabel("출력 스타일", { exact: true });
    await expectChoice(choice, "simple");
    expect((await settings()).find((item) => item.key === "output.style")!.layers.server.value).toBe("concise");
    await selectChoice(choice, "minimal");
    await expect.poll(async () => (await settings()).find((item) => item.key === "output.style")!.effective).toBe("minimal");
});

test("응답 언어·사용자 프로필 설정은 화면에서 제공하지 않는다", async ({ page }) => {
    await login(page);
    await openSettings(page);
    for (const [label, key] of [["응답 언어", "output.language"], ["사용자 프로필", "user.profile"]]) {
        await page.getByLabel("설정 검색").fill(label!);
        await expect(page.getByTestId(`setting-${key}`)).toHaveCount(0);
        await expect(page.getByText("검색 결과 0개 — 다른 낱말로 찾아보세요", { exact: true })).toBeVisible();
    }
});

for (const width of [390, 1280]) {
    test.describe(`${width}px 기본 지침`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        test("서버·프로젝트 설정에서 지침 전달 항목을 제공하지 않고 원본 파일을 보존한다", async ({ page }, info) => {
            const root = mkdtempSync(join(dirname(state().projA), "native-instructions-"));
            const files = { "AGENTS.md": "AGENT_NATIVE_FIXTURE", "CLAUDE.md": "CLAUDE_NATIVE_FIXTURE" };
            for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
            await login(page);
            await openSettings(page);
            await page.getByLabel("설정 검색").fill("프로젝트 지침 파일");
            await expect(page.getByText("검색 결과 0개 — 다른 낱말로 찾아보세요", { exact: true })).toBeVisible();
            await expect(page.getByTestId("setting-instructions.mode")).toHaveCount(0);
            await page.getByLabel("설정 검색").fill("응답 언어");
            await expect(page.getByTestId("setting-output.language")).toHaveCount(0);
            await page.screenshot({ path: info.outputPath("server-settings.png") });
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
            await openProjectSettings(page);
            await page.getByLabel("설정 검색").fill("프로젝트 지침 파일");
            await expect(page.getByText("검색 결과 0개 — 다른 낱말로 찾아보세요", { exact: true })).toBeVisible();
            await expect(page.getByTestId("setting-instructions.mode")).toHaveCount(0);
            await page.getByLabel("설정 검색").fill("응답 언어");
            await expect(page.getByTestId("setting-output.language")).toHaveCount(0);
            await page.screenshot({ path: info.outputPath("project-settings.png") });
            for (const [file, content] of Object.entries(files)) expect(readFileSync(join(root, file), "utf8")).toBe(content);
        });
    });
}
