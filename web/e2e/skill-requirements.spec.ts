import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openDetails, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";
import type { SessionSkills, SkillSelection } from "../app/api/skills";

test("요구 선언·명시적 의존 선택·실제 호출 capability·응답 유실·stale 복구를 일치시킨다", async ({ page }) => {
    const root = mkdtempSync(join(dirname(state().projA), "requirements-"));
    const skills = join(root, ".agents", "skills");
    const name = `requirements-${Date.now()}`;
    for (const skill of ["base", "review", "blocked"]) {
        mkdirSync(join(skills, skill), { recursive: true });
        writeFileSync(join(skills, skill, "SKILL.md"), `${name}-BODY-${skill}`);
    }
    const manifest = join(skills, "review", "requirements.grove.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, tools: ["read"], platforms: [process.platform === "win32" ? "windows" : process.platform], skills: ["base"] }));
    writeFileSync(join(skills, "blocked", "requirements.grove.json"), JSON.stringify({ version: 1, tools: ["unregistered_fixture_tool"] }));
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
        options: { capabilities: { tools: true } },
    });
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: name });
    const snapshot = () => apiCall<SessionSkills>("GET", `/sessions/${session.id}/skills`);
    const status = (id: string) => apiCall<{ status: string; error?: { code: string } }>("GET", `/turns/${id}`);
    const requests = () => fetch(`http://127.0.0.1:${state().fixturePort}/requests`).then((r) => r.json()) as Promise<{ messages: { role: string; content: unknown }[] }[]>;
    const send = (text: string, tools: boolean) => apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
        text, profile_id: profile.id, tools,
    });
    try {
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
        const view = sessionView(page, session.id);
        await openDetails(view.getByTestId("skills-disclosure"));
        const panel = view.getByTestId("session-skills");
        const row = (skill: string) => panel.getByRole("list", { name: "스킬 목록", exact: true }).locator(":scope > li").filter({ has: page.getByText(skill, { exact: true }) });
        await expect(row("blocked")).toContainText("skill_tool_unregistered");
        await expect(row("review")).toContainText("skill_dependency_unselected");
        await row("review").getByRole("button", { name: /본문 보기/ }).click();
        await expect(panel.getByRole("button", { name: "이 revision 선택 · 다음 모델 호출에 적용" })).toBeDisabled();
        expect((await snapshot()).selected).toHaveLength(0);
        await row("base").getByRole("button", { name: /본문 보기/ }).click();
        await panel.getByRole("button", { name: "이 revision 선택 · 다음 모델 호출에 적용" }).click();
        await expect(row("base")).toContainText("선택됨");
        await panel.getByLabel("검증할 모델").selectOption(profile.id);
        await expect(panel.getByLabel("검증할 도구 사용")).toBeEnabled();
        await panel.getByLabel("검증할 도구 사용").selectOption("false");
        await expect(row("review")).toContainText("skill_tools_disabled");
        await panel.getByLabel("검증할 도구 사용").selectOption("true");
        await expect(row("review")).toContainText("관측한 조건에서 요구사항 충족");
        await row("review").getByRole("button", { name: /본문 보기/ }).click();
        const keys: string[] = [];
        await page.route(`**/sessions/${session.id}/skills/selection`, async (route) => {
            keys.push(route.request().headers()["idempotency-key"]!);
            if (keys.length === 1) { await route.fetch(); await route.abort(); }
            else await route.continue();
        });
        await panel.getByRole("button", { name: "이 revision 선택 · 다음 모델 호출에 적용" }).click();
        await panel.getByRole("button", { name: "같은 요청 결과 확인" }).click();
        await expect(row("review")).toContainText("선택됨");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
        await page.unroute(`**/sessions/${session.id}/skills/selection`);
        const saved = (await snapshot()).selected;
        expect(saved).toHaveLength(2);

        // 화면의 충족 판정은 조회용 조건이다. 실제 접수된 tools=false는 반드시 거절한다.
        const disabledQuestion = `${name}-disabled`;
        const denied = await send(disabledQuestion, false);
        await expect.poll(async () => (await status(denied.turn.id)).status).toBe("failed");
        expect((await status(denied.turn.id)).error?.code).toBe("skill_tools_disabled");
        expect((await requests()).some((r) => JSON.stringify(r).includes(disabledQuestion))).toBe(false);
        const question = `${name}-success`;
        await script({ marker: question, frames: frames.text(["requirements fixture success"]) });
        const accepted = await send(question, true);
        await expect.poll(async () => (await status(accepted.turn.id)).status).toBe("completed");
        const request = (await requests()).find((r) => JSON.stringify(r).includes(question))!;
        expect(request.messages.find((m) => m.role === "system")?.content).toContain(`${name}-BODY-review`);
        expect(request.messages.find((m) => m.role === "system")?.content).toContain(`${name}-BODY-base`);
        expect(request.messages.find((m) => m.role === "system")?.content).not.toContain(`${name}-BODY-blocked`);

        await page.reload();
        await openDetails(sessionView(page, session.id).getByTestId("skills-disclosure"));
        const restored = sessionView(page, session.id).getByTestId("session-skills");
        await expect(restored).toContainText("요구사항 미확정");
        expect((await snapshot()).selected).toEqual(saved);
        expect((await requests()).filter((r) => JSON.stringify(r).includes(question))).toHaveLength(1);
        writeFileSync(manifest, JSON.stringify({ version: 1, tools: ["read"], skills: ["base"], platforms: ["not_supported"] }));
        await restored.getByRole("button", { name: "스킬 새로고침" }).click();
        await expect(restored).toContainText("skill_changed");
        const changed = await send(`${name}-stale`, true);
        await expect.poll(async () => (await status(changed.turn.id)).status).toBe("failed");
        expect((await status(changed.turn.id)).error?.code).toBe("skill_changed");
        expect((await snapshot()).selected).toEqual(saved);
        // revision을 바꾸거나 자동 재선택하지 않고 원래 binding을 명시적으로 해제한다.
        await row("review").getByRole("button", { name: "선택 해제", exact: true }).click();
        await expect(restored).toContainText("skill_platform_unsupported");
        rmSync(manifest);
        await restored.getByRole("button", { name: "스킬 새로고침" }).click();
        const currentReview = restored.getByRole("list", { name: "스킬 목록", exact: true }).locator(":scope > li")
            .filter({ has: page.getByText("review", { exact: true }) });
        await currentReview.getByRole("button", { name: /본문 보기/ }).click();
        await restored.getByRole("button", { name: "이 revision 선택 · 다음 모델 호출에 적용" }).click();
        await expect(currentReview).toContainText("선택됨");
        const recovered = (await snapshot()).selected;
        expect(recovered).toHaveLength(2);
        expect(recovered[0]).toEqual(saved[0]);
        expect(recovered[1]!.revision).not.toBe(saved[1]!.revision);
        const grants = await apiCall<{ items: unknown[] }>("GET", `/sessions/${session.id}/tool-grants`);
        expect(grants.items).toEqual([]);
    } finally {
        rmSync(root, { recursive: true });
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});

test("의존 스킬 해제는 기존 binding을 보존하고 다른 세션에는 선택을 전파하지 않는다", async ({ page }) => {
    const root = mkdtempSync(join(dirname(state().projA), "requirements-scope-"));
    const name = `requirement-scope-${Date.now()}`;
    for (const skill of ["base", "review"]) {
        const dir = join(root, ".agents", "skills", skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `${name}-${skill}`);
    }
    writeFileSync(join(root, ".agents", "skills", "review", "requirements.grove.json"), JSON.stringify({ version: 1, skills: ["base"] }));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const first = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `${name}-first` });
    const second = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `${name}-second` });
    try {
        const initial = await apiCall<SessionSkills>("GET", `/sessions/${first.id}/skills`);
        const bindings: SkillSelection[] = ["base", "review"].map((name) => {
            const { id, source, revision } = initial.listing.entries.find((entry) => entry.name === name)!;
            return { id, source, revision };
        });
        for (const selection of bindings) await apiCall("PUT", `/sessions/${first.id}/skills/selection`, { selection, selected: true });
        for (const session of [first, second]) await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(`${name}-first`) }).click();
        const view = sessionView(page, first.id);
        await openDetails(view.getByTestId("skills-disclosure"));
        const panel = view.getByTestId("session-skills");
        const base = panel.getByRole("list", { name: "스킬 목록", exact: true }).locator(":scope > li").filter({ has: page.getByText("base", { exact: true }) });
        await base.getByRole("button", { name: "선택 해제", exact: true }).click();
        await expect(panel).toContainText("skill_dependency_unselected");
        const snapshot = await apiCall<SessionSkills>("GET", `/sessions/${first.id}/skills`);
        expect(snapshot.selected).toEqual([bindings[1]]);
        await page.locator(".recent").getByRole("button", { name: new RegExp(`${name}-second`) }).click();
        await openDetails(sessionView(page, second.id).getByTestId("skills-disclosure"));
        const other = sessionView(page, second.id).getByTestId("session-skills");
        await expect(other).toContainText("skill_dependency_unselected");
        expect((await apiCall<SessionSkills>("GET", `/sessions/${second.id}/skills`)).selected).toEqual([]);
        await expect(other).not.toContainText("선택됨 · 다음 모델 호출 직전 재검증");
    } finally {
        rmSync(root, { recursive: true });
    }
});
