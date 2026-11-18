import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, composerOption, login, sessionView, state } from "./helpers";
import type { NativeCommandCatalog, Turn } from "../app/api/generated";

async function setup(protocol: "codex_cli" | "claude_code") {
    const root = mkdtempSync(join(state().projA, "native-skill-"));
    const skill = join(root, ".agents/skills/review/SKILL.md");
    mkdirSync(join(root, ".agents/skills/review"), { recursive: true });
    writeFileSync(skill, "NATIVE_SKILL_BODY_NOT_COPIED_BY_GROVE");
    const definitions = {
        codex: [{ name: "review", description: "Codex native review", enabled: true, path: skill, scope: "repo" }],
        claude: [{ name: "audit", description: "Claude native audit", argumentHint: "file" },
            { name: "model", description: "Claude native model", argumentHint: "name" }],
    };
    writeFileSync(join(root, "native-skills.json"), JSON.stringify(definitions));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `native-${protocol}-${Date.now()}`, protocol, base_url: "", model: "default",
    });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `native ${project.id}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    return { root, skill, definitions, project, profile, session, protocol };
}

async function open(page: Page, item: Awaited<ReturnType<typeof setup>>) {
    await login(page);
    if (page.viewportSize()!.width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`native ${item.project.id}`) }).click();
    const view = sessionView(page, item.session.id);
    await composerOption(view, "모델 프로필", JSON.stringify([item.profile.id, item.protocol === "codex_cli" ? "fixture-codex" : "fixture-claude"]));
    return view;
}

function calls(): { provider: string; cwd: string; text?: string; input?: unknown[] }[] {
    try { return readFileSync(join(state().cliDir!, "native-turns.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

for (const width of [390, 1400]) for (const protocol of ["codex_cli", "claude_code"] as const) {
    test.describe(`${width}px ${protocol} native skills`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760 });
        test("실제 CLI 목록으로 자동완성하고 네이티브 입력만 전달한다", async ({ page }, info) => {
            await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
            const item = await setup(protocol);
            const view = await open(page, item);
            const retired: string[] = [];
            page.on("request", (request) => {
                if (/\/sessions\/[^/]+\/skills(?:[/?]|$)/.test(request.url())) retired.push(request.url());
            });
            const input = view.getByLabel("메시지 입력", { exact: true });
            const name = protocol === "codex_cli" ? "review" : "audit";
            await input.fill("/");
            const menu = view.getByTestId("slash-list");
            await expect(menu).toContainText(`/${name}`);
            await expect(menu).toContainText(protocol === "codex_cli" ? "Codex native review" : "Claude native audit");
            if (protocol === "claude_code") await expect(menu).toContainText("/cli:model");
            await page.screenshot({ path: info.outputPath("native-slash-menu.png"), fullPage: true });
            await input.fill(`/${name} file.rs`);
            await input.press("Control+Enter");
            await expect(view.getByTestId("msg-assistant").last()).toContainText("에이전트 답변 1");
            await expect.poll(async () => (await apiCall<Turn[]>("GET", `/sessions/${item.session.id}/turns`))[0]?.status).toBe("completed");
            const wire = calls().filter((call) => call.cwd === item.root);
            expect(wire).toHaveLength(1);
            if (protocol === "codex_cli") {
                expect(wire[0]!.input).toContainEqual({ type: "skill", name: "review", path: item.skill });
                expect((wire[0]!.input![0] as { text: string }).text).toContain("$review file.rs");
            } else {
                expect(wire[0]!.text).toBe("/audit file.rs");
            }
            expect(JSON.stringify(wire)).not.toContain("NATIVE_SKILL_BODY_NOT_COPIED_BY_GROVE");
            const catalog = await apiCall<NativeCommandCatalog>("GET",
                `/projects/${item.project.id}/native-commands?profile_id=${item.profile.id}&session_id=${item.session.id}`);
            expect(JSON.stringify(catalog)).not.toContain(item.root);
            expect(retired).toEqual([]);
        });
    });
}

test("다른 프로젝트의 선택과 삭제된 스킬은 모델 턴을 실행하지 않는다", async ({ page }) => {
    const first = await setup("codex_cli");
    const second = await setup("codex_cli");
    const listing = (item: typeof first) => apiCall<NativeCommandCatalog>("GET",
        `/projects/${item.project.id}/native-commands?profile_id=${item.profile.id}&session_id=${item.session.id}`);
    const a = await listing(first);
    const b = await listing(second);
    expect(a.commands[0]!.id).not.toBe(b.commands[0]!.id);
    const denied = await apiCall<{ turn: Turn }>("POST", `/sessions/${second.session.id}/turns`, {
        text: "/review unsafe", profile_id: second.profile.id, native_command: a.commands[0]!.id,
    });
    await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${denied.turn.id}`)).status).toBe("failed");
    expect(calls().filter((call) => call.cwd === second.root)).toEqual([]);
    const view = await open(page, first);
    const input = view.getByLabel("메시지 입력", { exact: true });
    await input.fill("/review");
    await expect(view.getByTestId("slash-list")).toContainText("Codex native review");
    writeFileSync(join(first.root, "native-skills.json"), JSON.stringify({ codex: [], claude: first.definitions.claude }));
    await input.fill("/review changed");
    await input.press("Control+Enter");
    await expect.poll(async () => (await apiCall<Turn[]>("GET", `/sessions/${first.session.id}/turns`))[0]?.status).toBe("failed");
    expect(calls().filter((call) => call.cwd === first.root)).toEqual([]);
    const failed = (await apiCall<Turn[]>("GET", `/sessions/${first.session.id}/turns`))[0]!;
    writeFileSync(join(first.root, "native-skills.json"), JSON.stringify(first.definitions));
    const retried = await apiCall<{ turn: Turn }>("POST", `/turns/${failed.id}/retry`, {});
    expect(retried.turn.id).not.toBe(failed.id);
    expect(retried.turn.definition).toMatchObject({ native_command: a.commands[0]!.id });
    await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${retried.turn.id}`)).status).toBe("completed");
    const wire = calls().filter((call) => call.cwd === first.root);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.input).toContainEqual({ type: "skill", name: "review", path: first.skill });
});

test("모델 전환 뒤 늦은 목록은 새 CLI 목록과 섞이지 않는다", async ({ page }) => {
    const item = await setup("codex_cli");
    const claude = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `native-claude-${Date.now()}`, protocol: "claude_code", base_url: "", model: "default",
    });
    const view = await open(page, item);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received!: () => void;
    const captured = new Promise<void>((resolve) => { received = resolve; });
    await page.route(`**/projects/${item.project.id}/native-commands?*`, async (route) => {
        if (new URL(route.request().url()).searchParams.get("profile_id") !== item.profile.id) return route.continue();
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
    });
    try {
        await view.getByLabel("메시지 입력").fill("/");
        await captured;
        await composerOption(view, "모델 프로필", JSON.stringify([claude.id, "fixture-claude"]));
        await view.getByLabel("메시지 입력").focus();
        await expect(view.getByTestId("slash-list")).toContainText("Claude native audit");
        const completed = page.waitForResponse((response) => response.url().includes("native-commands") && response.url().includes(item.profile.id));
        release();
        await completed;
        await expect(view.getByTestId("slash-list")).not.toContainText("Codex native review");
        const apiProfile = await apiCall<{ id: string }>("POST", "/model-profiles", {
            name: `native-api-${Date.now()}`, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
        });
        await composerOption(view, "모델 프로필", apiProfile.id);
        await view.getByLabel("메시지 입력").fill("/audit file.rs");
        await expect(view.getByTestId("slash-list")).toHaveCount(0);
        await view.getByLabel("메시지 입력").press("Control+Enter");
        await expect(view).toContainText("알 수 없는 명령");
        expect(calls().filter((call) => call.cwd === item.root)).toEqual([]);
    } finally { release(); }
});
