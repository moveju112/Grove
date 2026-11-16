import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProfile, ensureProjects, login, openDetails, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";
import type { SessionSkills } from "../app/api/skills";

test("명시적 스킬 선택·재전송·모델 적용·변경 및 삭제 차단·해제를 연결한다", async ({ page }) => {
    const root = mkdtempSync(join(dirname(state().projA), "skills-"));
    const skillDir = join(root, ".agents", "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    const marker = `selected-skill-${Date.now()}`;
    writeFileSync(file, marker);
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: marker });
    const profile = await ensureProfile();
    try {
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(marker) }).click();
        const view = sessionView(page, session.id);
        await openDetails(view.getByTestId("skills-disclosure"));
        const panel = view.getByTestId("session-skills");
        await expect(panel).toContainText("스킬 선택은 도구 실행 승인이 아닙니다.");
        await expect(page.getByRole("tooltip")).toBeHidden();
        await panel.getByRole("button", { name: "스킬 도움말", exact: true }).hover();
        await expect(page.getByRole("tooltip")).toContainText("자동 매칭 없음");
        await page.keyboard.press("Escape");
        await panel.getByRole("button", { name: /review .*본문 보기/ }).click();
        await expect(panel.getByLabel("스킬 본문")).toContainText(marker);
        const sent: string[] = [];
        await page.route(`**/sessions/${session.id}/skills/selection`, async (route) => {
            sent.push(route.request().headers()["idempotency-key"]!);
            if (sent.length === 1) { await route.fetch(); await route.abort(); }
            else await route.continue();
        });
        await panel.getByRole("button", { name: "이 스킬 사용" }).click();
        await panel.getByRole("button", { name: "같은 요청 결과 확인" }).click();
        await expect(panel).toContainText("선택됨");
        expect(sent).toHaveLength(2);
        expect(sent[0]).toBe(sent[1]);
        const selections = () => apiCall<SessionSkills>("GET", `/sessions/${session.id}/skills`);
        expect((await selections()).selected).toHaveLength(1);
        const question = `skills-question-${Date.now()}`;
        await script({ frames: frames.text(["skill fixture answer"]), marker: question });
        const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
        const status = (id: string) => apiCall<{ status: string; error?: { code: string } }>("GET", `/turns/${id}`);
        await expect.poll(async () => (await status(turn.turn.id)).status).toBe("completed");
        const requests = await fetch(`http://127.0.0.1:${state().fixturePort}/requests`).then((r) => r.json()) as { messages: { role: string; content: unknown }[] }[];
        const request = requests.find((r) => JSON.stringify(r.messages).includes(question))!;
        expect(request.messages.find((m) => m.role === "system")?.content).toContain(marker);
        await page.reload();
        await openDetails(sessionView(page, session.id).getByTestId("skills-disclosure"));
        const restored = sessionView(page, session.id).getByTestId("session-skills");
        await expect(restored).toContainText("선택됨");
        writeFileSync(file, "CHANGED_SKILL_MUST_NOT_APPLY");
        await restored.getByRole("button", { name: "스킬 새로고침" }).click();
        await expect(restored).toContainText("선택한 스킬을 적용할 수 없습니다");
        const blocked = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: "changed skill fixture", profile_id: profile });
        await expect.poll(async () => (await status(blocked.turn.id)).status).toBe("failed");
        expect((await status(blocked.turn.id)).error?.code).toBe("skill_changed");
        rmSync(file);
        await restored.getByRole("button", { name: "스킬 새로고침" }).click();
        await expect(restored).toContainText("skill_not_found");
        await restored.getByRole("button", { name: "이 선택 해제" }).click();
        await expect.poll(async () => (await selections()).selected.length).toBe(0);
        await expect(restored).not.toContainText("선택한 스킬을 적용할 수 없습니다");
    } finally {
        rmSync(root, { recursive: true });
    }
});

for (const theme of ["light", "dark"] as const) {
    test.describe(`390px 스킬 안내 ${theme}`, () => {
        test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        test("긴 안내는 도움말에서만 표시하고 터치·키보드로 열고 닫는다", async ({ page }, info) => {
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            const { a } = await ensureProjects();
            const title = `간결한 스킬 안내 ${theme} ${Date.now()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            await openDetails(sessionView(page, session.id).getByTestId("skills-disclosure"));
            const panel = sessionView(page, session.id).getByTestId("session-skills");
            const help = panel.getByRole("button", { name: "스킬 도움말", exact: true });
            await expect(panel.getByRole("region", { name: "스킬 탐색과 선택", exact: true })).toHaveAttribute("aria-busy", "false");
            await expect(help).toBeVisible();
            await expect(panel).toContainText("스킬 선택은 도구 실행 승인이 아닙니다.");
            await expect(page.getByRole("tooltip")).toBeHidden();
            const paragraphs = await panel.locator('p[data-color="secondary"]').filter({ visible: true }).allTextContents();
            for (const text of paragraphs) {
                expect(text.trim().length).toBeLessThan(80);
                expect((text.match(/[.!?。！？](?:\s|$)/gu) ?? []).length).toBeLessThanOrEqual(1);
            }
            await page.screenshot({ path: info.outputPath("skills-compact.png"), fullPage: true });
            expect(await help.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                    ?.closest("button")?.getAttribute("aria-label");
            })).toBe("스킬 도움말");
            await help.tap();
            await expect(page.getByRole("tooltip")).toContainText("requirements.grove.json");
            const foreground = theme === "light" ? "rgb(255, 255, 255)" : "rgb(23, 26, 32)";
            await expect(page.getByRole("tooltip").getByText("직접 선택한 스킬만 다음 모델 호출에 적용합니다.", { exact: true })).toHaveCSS("color", foreground);
            const bounds = await page.getByRole("tooltip").boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
            await page.screenshot({ path: info.outputPath("skills-help.png"), fullPage: true });
            await page.keyboard.press("Escape");
            await expect(page.getByRole("tooltip")).toBeHidden();
            await page.keyboard.press("Tab");
            await help.focus();
            await page.keyboard.press("Enter");
            await expect(page.getByRole("tooltip")).toContainText("동명 항목·alias");
            await page.keyboard.press("Escape");
            await expect(page.getByRole("tooltip")).toBeHidden();
        });
    });
}

test("다른 세션으로 전환한 뒤 늦게 도착한 이전 선택 응답을 표시하지 않는다", async ({ page }) => {
    const root = mkdtempSync(join(dirname(state().projA), "skills-switch-"));
    mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "review", "SKILL.md"), "session scope fixture");
    const name = `skill-switch-${Date.now()}`;
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const first = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `${name}-first` });
    const second = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `${name}-second` });
    const snapshot = await apiCall<SessionSkills>("GET", `/sessions/${first.id}/skills`);
    const { id, source, revision } = snapshot.listing.entries.find((entry) => entry.name === "review")!;
    await apiCall("PUT", `/sessions/${first.id}/skills/selection`, { selection: { id, source, revision }, selected: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    let finished!: () => void;
    const returned = new Promise<void>((resolve) => { finished = resolve; });
    await page.route(`**/sessions/${first.id}/skills`, async (route) => {
        const response = await route.fetch();
        requested();
        await gate;
        await route.fulfill({ response });
        finished();
    });
    try {
        for (const session of [first, second]) await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${name}-first`) }).click();
        await openDetails(sessionView(page, first.id).getByTestId("skills-disclosure"));
        await started;
        await page.getByRole("dialog", { name: "대화 스킬", exact: true }).getByRole("button", { name: "닫기", exact: true }).click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${name}-second`) }).click();
        const view = sessionView(page, second.id);
        await openDetails(view.getByTestId("skills-disclosure"));
        const panel = view.getByTestId("session-skills");
        await expect(panel.getByRole("button", { name: /review .*본문 보기/ })).toBeVisible();
        await expect(panel).not.toContainText("선택됨");
        release();
        await returned;
        await expect(panel).not.toContainText("선택됨");
    } finally {
        release();
        rmSync(root, { recursive: true });
    }
});
