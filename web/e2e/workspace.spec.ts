import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { frames } from "./fixture";
import { splitRecentItem, apiCall, composerOption, ensureProfile, ensureProjects, expectChoice, login, openUsage, openBots, openContext, openDetails, openProjectFiles, openTool, requireToolApproval, script, selectChoice, sessionView, settingsGroupHeader, startProjectConversation, state } from "./helpers";

test("CSP·보안 헤더와 PWA manifest를 제공한다", async ({ request }) => {
    const r = await request.get("/");
    expect(r.status()).toBe(200);
    const csp = r.headers()["content-security-policy"]!;
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).not.toContain("'unsafe-inline' ;");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(r.headers()["x-content-type-options"]).toBe("nosniff");
    const m = await request.get("/manifest.webmanifest");
    expect((await m.json()).display).toBe("standalone");
    const sw = await request.get("/sw.js");
    expect(await sw.text()).not.toContain("__GROVE_BUILD__");
});

test("첫 방문에서 service worker가 페이지를 넘겨받아도 입력 중인 값이 지워지지 않는다", async ({ page }) => {
    await page.goto("/");
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
    await page.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
    await page.getByRole("textbox", { name: "페어링 링크" }).fill("입력-중인-값");
    // 설치·활성화·claim으로 controller가 생길 때까지 기다린다
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await expect(page.getByRole("textbox", { name: "페어링 링크" })).toHaveValue("입력-중인-값");
});

test("로그인 후 새로고침해도 쿠키로 세션이 복원되고 토큰은 저장하지 않는다", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await login(page);
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toContain(state().token.split(".")[1]!);
    expect(errors.filter((e) => /Content Security Policy/.test(e))).toEqual([]);
});

test("두 프로젝트를 좌우·위아래로 열고 각 탭이 자기 프로젝트에 고정되며 새로고침 후 복원된다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    const sa = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "A의 대화" });
    const sb = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: "B의 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sa.id });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: sb.id });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    await recent.getByRole("button", { name: /A의 대화/ }).click();
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-session", sa.id);
    // 프로젝트 자체를 오른쪽에 배치한 뒤 같은 영역에서 B의 대화를 연다.
    const aPane = page.locator(`[data-project-pane="${a.id}"]`).getByTestId("pane");
    const bPane = page.locator(`[data-project-pane="${b.id}"]`).getByTestId("pane");
    const bounds = (await aPane.boundingBox())!;
    await page.getByTestId("projects").getByRole("button", { name: b.name, exact: true }).dragTo(aPane, {
        targetPosition: { x: bounds.width - 12, y: bounds.height / 2 },
    });
    await expect(bPane).toBeVisible();
    await recent.getByRole("button", { name: "B의 대화", exact: true }).click();
    await expect(page.getByTestId("pane").filter({ visible: true })).toHaveCount(2);
    const divider = page.getByTestId("project-divider");
    await expect(divider).toHaveAttribute("data-direction", "row");
    const views = page.getByTestId("session-view");
    await expect(views.nth(0)).toHaveAttribute("data-session", sa.id);
    await expect(views.nth(1)).toHaveAttribute("data-session", sb.id);
    // 각 pane에서 메시지 저장 → 원래 세션에만 기록(FLOW-11)
    for (const [i, text] of [[0, "왼쪽에서"], [1, "오른쪽에서"]] as const) {
        const pane = page.getByTestId("pane").nth(i);
        await composerOption(pane, "보내기 방식", "save");
        await pane.getByLabel("메시지 입력").fill(text);
        await pane.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(pane.getByTestId("msg-user").last()).toHaveText(new RegExp(text));
    }
    const ma = await apiCall<{ items: { content: { text: string } }[] }>("GET", `/sessions/${sa.id}/messages`);
    const mb = await apiCall<{ items: { content: { text: string } }[] }>("GET", `/sessions/${sb.id}/messages`);
    expect(ma.items.map((m) => m.content.text)).toEqual(["왼쪽에서"]);
    expect(mb.items.map((m) => m.content.text)).toEqual(["오른쪽에서"]);
    // 위아래로 전환
    await divider.dblclick();
    await expect(divider).toHaveAttribute("data-direction", "column");
    // 서버 저장 대기 후 새로고침 → 복원
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(divider).toHaveAttribute("data-direction", "column");
    await expect(aPane.getByTestId("session-view")).toHaveAttribute("data-session", sa.id);
    await expect(bPane.getByTestId("session-view")).toHaveAttribute("data-session", sb.id);
    expect((await bPane.boundingBox())!.y).toBeGreaterThan((await aPane.boundingBox())!.y);
    // 연결된 프로젝트 영역은 남지만 B 대화 탭만 사라진다.
    await bPane.getByRole("tab", { name: /B의 대화/ }).getByRole("button", { name: "탭 닫기", exact: true }).click();
    await expect(bPane.getByTestId("session-view")).toHaveCount(0);
    await expect(aPane.getByTestId("session-view")).toHaveAttribute("data-session", sa.id);
    const still = await apiCall<{ archived_at: string | null }>("GET", `/sessions/${sb.id}`);
    expect(still.archived_at).toBeNull();
    // 새 브라우저에서도 서버 배치를 복원하므로 시험에서 연 분할은 닫아 둔다.
    await bPane.getByRole("button", { name: "프로젝트 분할 닫기", exact: true }).click();
    await expect(divider).toHaveCount(0);
});

test("모델 응답이 중간 표시 후 확정되고, 쓰기 도구 거부 시 파일이 생기지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await requireToolApproval(a.id);
    await ensureProfile();
    const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: "모델 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /모델 대화/ }).first().click();
    const view = sessionView(page, s.id);
    await expect(view).toHaveAttribute("data-session", s.id);
    await script({ frames: frames.text(["천천히 ", "도착하는 ", "답변"]), delayMs: 400 });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("답해줘");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("partial")).toBeVisible();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("천천히 도착하는 답변", { timeout: 15_000 });
    await expect(view.getByTestId("partial")).toHaveCount(0);

    // 도구: 쓰기 요청 → 승인 카드 → 거부
    await script({ frames: frames.tool("w1", "write", { path: "made.txt", content: "x" }) });
    await script({ frames: frames.text(["거부 확인"]) });
    await composerOption(view, "도구", true);
    await view.getByLabel("메시지 입력").fill("파일 만들어");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const card = view.getByTestId("approval");
    await expect(card).toContainText("made.txt", { timeout: 15_000 });
    await card.getByRole("button", { name: "거부" }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("거부 확인", { timeout: 15_000 });
    expect(existsSync(join(state().projA, "made.txt"))).toBe(false);

    // 이 대화에서 승인 → 다음 write는 승인 카드 없이 실행된다.
    await script({ frames: frames.tool("w2", "write", { path: "granted1.txt", content: "1" }) });
    await script({ frames: frames.text(["첫 쓰기"]) });
    await view.getByLabel("메시지 입력").fill("파일 하나");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(card).toContainText("granted1.txt", { timeout: 15_000 });
    await card.getByRole("button", { name: "이 대화에서 승인" }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("첫 쓰기", { timeout: 15_000 });
    await script({ frames: frames.tool("w3", "write", { path: "granted2.txt", content: "2" }) });
    await script({ frames: frames.text(["둘째 쓰기"]) });
    await view.getByLabel("메시지 입력").fill("파일 둘");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("둘째 쓰기", { timeout: 15_000 });
    expect(existsSync(join(state().projA, "granted2.txt"))).toBe(true);
    const calls = await apiCall<{ args: { path: string }; approval_scope: string; started_at: string; finished_at: string; result: unknown }[]>("GET", `/tool-calls?session_id=${s.id}`);
    const call = calls.find((row) => row.args.path === "granted2.txt")!;
    expect(call.approval_scope).toBe("session");
    expect(Date.parse(call.finished_at)).toBeGreaterThanOrEqual(Date.parse(call.started_at));
    expect(call.result).toBeTruthy();
    await expect(view.getByTestId("msg-tool")).toHaveCount(0);
    await composerOption(view, "도구", false);
});

test("자식 에이전트 위임을 승인하면 자식 대화가 생기고 결과가 부모 대화에 한 번 보고된다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: "위임 대화" });
    await apiCall("PUT", `/settings/session/${s.id}/agents.orchestration`, { expected_revision: 0, value: "delegated" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /위임 대화/ }).first().click();
    // 뒤에서 자식 대화가 두 번째 pane에 열리므로 부모 화면을 첫 pane으로 고정한다.
    const view = page.getByTestId("session-view").first();
    await expect(view).toHaveAttribute("data-session", s.id);
    const prompt = `검토 맡겨 ${s.id}`;
    await script({ frames: frames.tool("a1", "agent", { action: "spawn", agent_id: "reviewer", brief: "변경을 검토해" }), marker: prompt });
    await script({ frames: frames.text(["검토를 맡겼어"]), marker: prompt });
    await script({ frames: frames.text(["자식 검토 결과를 확인했어"]), marker: prompt });
    await script({ frames: frames.text(["자식 검토 결과: 이상 없음"]), delayMs: 200, marker: "Delegated task" });
    await composerOption(view, "보내기 방식", "model");
    await composerOption(view, "도구", true);
    await view.getByLabel("메시지 입력").fill(prompt);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const card = view.getByTestId("approval");
    await expect(card).toContainText("reviewer", { timeout: 15_000 });
    // 위임은 대화 범위로 허용할 수 없다(일회 승인만)
    await expect(card.getByRole("button", { name: "이 대화에서 승인" })).toHaveCount(0);
    await card.getByRole("button", { name: "이번만 승인" }).click();
    await expect(view.getByTestId("msg-agent-result")).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("msg-agent-result")).toContainText("자식 검토 결과: 이상 없음");
    await expect(view.getByTestId("turn-status")).toHaveCount(0);
    const turns = await apiCall<{ status: string; error: unknown }[]>("GET", `/sessions/${s.id}/turns`);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("completed");
    expect(turns[0]!.error).toBeNull();
    const runs = view.getByTestId("agent-runs");
    await openTool(view, "에이전트");
    await expect(runs.getByTestId("agent-run").first()).toHaveAttribute("data-status", "completed");
    await openDetails(runs);
    // 자식 대화를 열면 부모 연결이 보인다
    await runs.getByRole("button", { name: "자식 대화" }).first().click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const child = page.getByTestId("session-view").nth(1);
    await openTool(child, "에이전트");
    await expect(child.getByTestId("agent-runs")).toContainText("부모 대화 열기");
    await expect(child.getByTestId("msg-who").first()).toHaveText("부모 에이전트의 지시");
    await expect(child.getByTestId("msg-assistant").last()).toContainText("자식 검토 결과");
    await composerOption(view, "도구", false);
});

test("Goal을 추가·완료·순서 변경하고 다른 화면의 변경이 실시간 반영된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "Goal 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /Goal 대화/ }).first().click();
    const panel = page.getByTestId("goals-panel");
    await openTool(page, "Goal");
    await openDetails(panel);
    for (const t of ["첫째", "둘째"]) {
        await panel.getByLabel("새 Goal").fill(t);
        await panel.getByRole("button", { name: "추가" }).click();
        await expect(panel.getByTestId("goal").filter({ hasText: t })).toHaveCount(1);
    }
    await panel.getByRole("button", { name: "둘째 위로" }).click();
    await expect(panel.getByTestId("goal").first()).toContainText("둘째");
    await selectChoice(panel.getByTestId("goal").filter({ hasText: "첫째" }).getByRole("combobox"), "true");
    await expect(panel.getByTestId("goal").filter({ hasText: "첫째" })).toHaveAttribute("data-status", "done");
    await expect(panel.getByRole("heading")).toContainText("남은 1/2");
    // 다른 기기(API)에서 추가하면 이벤트로 반영
    await apiCall("POST", `/sessions/${s.id}/goals`, { title: "밖에서 추가" });
    await expect(panel.getByTestId("goal").filter({ hasText: "밖에서 추가" })).toHaveCount(1);
});

test("Git 변경에서 hunk 하나만 올리고 커밋하면 나머지 변경은 작업 트리에 남는다", async ({ page }) => {
    const root_path = mkdtempSync(join(dirname(state().projA), "git-hunks-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root_path, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "e2e@example.invalid");
    run("config", "user.name", "E2E");
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}\n`);
    writeFileSync(join(root_path, "h.txt"), lines.join(""));
    run("add", "h.txt");
    run("commit", "-qm", "base");
    lines[1] = "LINE2\n";
    lines[27] = "LINE28\n";
    writeFileSync(join(root_path, "h.txt"), lines.join(""));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path });
    await login(page);
    await page.getByTestId("projects").getByRole("button", { name: project.name, exact: true }).click();
    const pane = page.locator(`[data-project-pane="${project.id}"]`);
    await openTool(pane, "변경");
    const panel = pane.getByTestId("git-panel");
    await panel.getByRole("button", { name: "h.txt" }).first().click();
    await expect(panel.getByTestId("hunk")).toHaveCount(2);
    await panel.getByTestId("hunk").nth(1).getByRole("button", { name: "이 부분 올리기" }).click();
    await expect(panel.getByTestId("hunk")).toHaveCount(1);
    await expect(panel).toContainText("커밋할 변경 (1)");
    await panel.getByLabel("커밋 메시지").fill("28번째 줄만");
    await panel.getByRole("button", { name: "커밋", exact: true }).click();
    await expect.poll(() => run("log", "-1", "--format=%s").trim()).toBe("28번째 줄만");
    expect(run("show", "--format=", "HEAD")).toContain("+LINE28");
    expect(run("diff")).toContain("+LINE2\n");
});

test("context 사용량을 추정/실측으로 표시하고 수동 압축 결과를 이전 대화 요약으로 보여 준다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "압축 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /압축 대화/ }).first().click();
    const view = page.getByTestId("session-view").first();
    await composerOption(view, "보내기 방식", "model");
    // 요약이 원문보다 짧아야 적용되므로(CMP-006) 첫 답은 요약보다 길게 둔다
    for (const [q, ans] of [["첫 질문", `첫 답 ${"자세한 설명 ".repeat(20)}`], ["둘째 질문", "둘째 답"]]) {
        await script({ frames: frames.text([ans!]) });
        await view.getByLabel("메시지 입력").fill(q!);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText(ans!, { timeout: 15_000 });
    }
    const meter = await openContext(view);
    await expect(meter).toContainText("context");
    await expect(meter).toContainText("(추정)");
    await script({ frames: frames.text(["요약: 첫 질문에 답했다"]), marker: "You compress a conversation" });
    await meter.getByRole("button", { name: "압축" }).click();
    await expect(view.getByTestId("msg-compaction")).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("msg-compaction")).toContainText("수동 압축");
    // CMP-011: 적용 구간과 원문 보존을 함께 보여 준다
    await openDetails(view.getByTestId("msg-compaction"));
    await expect(view.getByTestId("compaction-source")).toContainText("원문은 화면 이력에 그대로 남습니다");
    // 화면 이력은 그대로 남는다
    await expect(view.getByTestId("msg-assistant").first()).toContainText("첫 답");
});

test("서버 protocol이 바뀌면 새로고침을 안내하고 변경 요청을 보내지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const view = page.getByTestId("project-view").first();
    await startProjectConversation(view);
    await composerOption(view, "보내기 방식", "save");
    let mutations = 0;
    // 서버만 먼저 업데이트된 상황: 응답 protocol을 다른 값으로 바꾼다
    await page.route("**/api/v1/**", async (route) => {
        if (route.request().method() !== "GET") mutations++;
        const r = await route.fetch();
        await route.fulfill({ response: r, headers: { ...r.headers(), "x-grove-protocol": "999" } });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("protocol-banner")).toBeVisible();
    await expect(page.getByTestId("protocol-banner")).toContainText("protocol 999");
    // 변경 요청(새 대화)은 클라이언트에서 막힌다
    await view.getByLabel("메시지 입력").fill("보내지면 안 됨");
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
    await view.getByLabel("메시지 입력").press("Control+Enter");
    await expect(view.getByLabel("메시지 입력")).toHaveValue("보내지면 안 됨");
    expect(mutations).toBe(0);
    await page.unroute("**/api/v1/**");
});

test("작성 중인 입력은 저장하지 않으며 새로고침 뒤 복원하지 않는다", async ({ page }) => {
    const { b } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: "초안 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /초안 대화/ }).first().click();
    const view = sessionView(page, s.id);
    await view.getByLabel("메시지 입력").fill("아직 안 보낸 글");
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(view.getByLabel("메시지 입력")).toHaveValue("");
    await expect(view.getByRole("button", { name: "초안", exact: true })).toHaveCount(0);
});

test("설정 검색은 항목과 적용 범위를 보여 주고 기본 에이전트 수정·복원을 할 수 있다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("테마");
    await expect(page.getByTestId("setting-theme")).toContainText("이 기기");
    await expect(page.getByTestId("setting-secrets")).toHaveCount(0);
    await page.getByLabel("설정 검색").fill("");
    await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
    await page.getByRole("button", { name: "위임 에이전트", exact: true }).click();
    await page.getByTestId("definition-reviewer").getByRole("button", { name: /^Reviewer/ }).and(page.locator("[aria-pressed]")).click();
    const editor = page.getByLabel("정의 본문");
    const original = await editor.inputValue();
    await editor.fill(original + "\n추가 지침");
    await editor.blur();
    await expect(page.getByTestId("setting-definitions").getByText("저장됨")).toBeVisible();
    const d =await apiCall<{ modified_fields: string[]; revision: number }>("GET", "/definitions/agent/reviewer");
    expect(d.modified_fields).toEqual(["body"]);
    await expect(page.getByRole("region", { name: "정의 기본값 비교", exact: true })).toHaveCount(0);
    await apiCall("PUT", "/definitions/agent/reviewer", { expected_revision: d.revision, body: original });
    expect((await apiCall<{ body: string }>("GET", "/definitions/agent/reviewer")).body).toBe(original);
});

test("파일 화면에서 열고 고쳐 저장하며, 외부 변경은 충돌로 알리고 내 편집을 지키며, 이미지는 티켓으로 미리 본다", async ({ page }) => {
    const { a } = await ensureProjects();
    const proj = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    writeFileSync(join(proj.root_path, "note.md"), "처음\n");
    // 1x1 PNG
    writeFileSync(join(proj.root_path, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await login(page);
    await page.getByTestId("projects").getByRole("button", { name: a.name, exact: true }).click();
    const projectScreen = page.getByTestId("navigation-context").getByRole("button", { name: /프로젝트 화면으로$/ });
    const projectView = page.getByTestId("project-view").filter({ visible: true });
    await expect(projectView.or(projectScreen).first()).toBeVisible();
    if (!await projectView.isVisible()) await projectScreen.click();
    await openProjectFiles(page);
    const files = page.getByTestId("files-view");
    await files.getByRole("button", { name: "note.md", exact: true }).click();
    const editor = files.getByLabel("파일 내용");
    await expect(editor).toHaveValue("처음\n");
    await editor.fill("고침\n");
    await expect(files.getByText("● 저장 안 됨")).toBeVisible();
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").filter({ hasText: /\S/ })).toHaveText("저장됨");
    expect(readFileSync(join(proj.root_path, "note.md"), "utf8")).toBe("고침\n");
    // 외부 변경 뒤 저장 → 충돌, 파일과 내 편집 모두 보존
    await editor.fill("내 편집\n");
    writeFileSync(join(proj.root_path, "note.md"), "밖에서 바꿈\n");
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status").or(files.getByRole("alert")).filter({ hasText: "파일이 바뀌었습니다" })).toBeVisible();
    await expect(editor).toHaveValue("내 편집\n");
    expect(readFileSync(join(proj.root_path, "note.md"), "utf8")).toBe("밖에서 바꿈\n");
    // 이미지 미리보기: 인증 헤더 없이 티켓 URL로 실제로 그려진다
    await files.getByRole("button", { name: "dot.png", exact: true }).click();
    const img = files.getByRole("img");
    await expect(img).toHaveAttribute("src", /\/api\/v1\/file-tickets\//);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
});

test("백그라운드 작업은 시작·취소할 수 있지만 결과는 작업 목록에서만 확인한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const sess = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: "작업 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sess.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /작업 대화/ }).first().click();
    // 앞선 시험이 분할 배치를 남겼을 수 있어 이 대화 화면 안에서만 찾는다.
    const view = sessionView(page, sess.id);
    const panel = view.getByTestId("tasks-panel");
    await openTool(view, "작업");
    await openDetails(panel);
    await panel.getByLabel("백그라운드 명령").fill("echo 백그라운드-완료");
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(panel.getByTestId("task-row").first()).toHaveAttribute("data-status", "completed");
    await panel.getByTestId("task-row").first().getByRole("button", { name: "출력" }).click();
    await expect(panel.getByTestId("task-output")).toContainText("백그라운드-완료");
    // 오래 걸리는 작업 취소
    await panel.getByLabel("백그라운드 명령").fill("sleep 30");
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    const runningRow = panel.locator('[data-testid="task-row"][data-status="running"]');
    await expect(runningRow).toHaveCount(1);
    await runningRow.getByRole("button", { name: "취소" }).click();
    await expect(panel.locator('[data-testid="task-row"][data-status="cancelled"]')).toHaveCount(1);
    await expect(view.getByTestId("msg-task-result")).toHaveCount(0);
});

test("터미널을 열어 입력·출력하고 새로고침으로 복원한 뒤 탭을 닫아 종료한다", async ({ page }) => {
    const root_path = mkdtempSync(join(dirname(state().projA), "terminal-restore-"));
    const a = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path });
    await login(page);
    await page.getByTestId("projects").getByRole("button", { name: a.name, exact: true }).click();
    const projectScreen = page.getByTestId("navigation-context").getByRole("button", { name: /프로젝트 화면으로$/ });
    const projectView = page.getByTestId("project-view").filter({ visible: true });
    await expect(projectView.or(projectScreen).first()).toBeVisible();
    if (!await projectView.isVisible()) await projectScreen.click();
    const list = projectView.getByTestId("terminal-list");
    await openTool(projectView, "터미널");
    await openDetails(list, "터미널", projectView);
    await list.getByRole("button", { name: "새 터미널" }).click();
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    await view.locator(".xterm").click();
    await page.keyboard.type("stty -echo; printf '\\033[2J\\033[He2e-%s\\n' \"$((20+22))\"");
    await page.keyboard.press("Enter");
    await expect(view.locator(".xterm-rows")).toContainText("e2e-42");
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute("data-conn", "open");
    await expect(view.locator(".xterm-rows")).toContainText("e2e-42");
    const terminals = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
    const terminal = terminals.terminals.find((item) => item.status === "running")!;
    const close = page.locator(`[data-project-pane="${a.id}"]`).getByRole("tab", { selected: true })
        .getByRole("button", { name: "탭 닫기", exact: true });
    await expect(close).toBeVisible();
    await close.click();
    await expect(view).toHaveCount(0);
    const ended = await apiCall<{ terminals: { id: string; status: string }[] }>("GET", `/projects/${a.id}/terminals`);
    expect(ended.terminals.find((item) => item.id === terminal.id)?.status).toBe("exited");
});

test("봇을 만들고 home 대화에서 답을 받고, 새로고침·분할 뒤에도 같은 대화이며 초기화·삭제·복원을 할 수 있다", async ({ page }) => {
    await ensureProjects();
    const profile = await ensureProfile();
    await login(page);
    await openBots(page);
    const panel = page.getByTestId("bots-panel");
    await panel.getByRole("button", { name: "봇 작업", exact: true }).click();
    await panel.getByRole("button", { name: "봇 만들기" }).click();
    const ed = panel.getByTestId("bot-editor");
    await ed.getByLabel("봇 이름").fill("e2e 봇");
    await ed.getByLabel("persona").fill("짧게 답한다");
    await ed.getByRole("button", { name: "봇 만들기" }).click();
    const item = panel.getByTestId("bot").filter({ hasText: "e2e 봇" });
    await expect(item).toContainText("모델 없음");
    // 모델 설정
    await item.getByRole("button", { name: "e2e 봇 관리", exact: true }).click();
    await page.getByRole("group", { name: "e2e 봇 관리", exact: true }).getByRole("button", { name: "편집", exact: true }).click();
    await selectChoice(panel.getByTestId("bot-editor").getByLabel("봇 모델"), profile);
    await expect(panel.getByTestId("bot-editor")).toContainText("저장됨");
    await expect(item).not.toContainText("모델 없음");
    // home 대화
    await item.getByRole("button", { name: "e2e 봇", exact: false }).first().click();
    const view = page.getByTestId("session-view").last();
    await expect(view.getByTestId("bot-chip")).toBeVisible();
    const sid = await view.getAttribute("data-session");
    await script({ frames: frames.text(["봇 응답"]) });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("안녕");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("봇 응답", { timeout: 15_000 });
    // 새로고침 뒤 다시 열어도 같은 대화
    await page.reload();
    await openBots(page);
    await page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" }).getByRole("button", { name: "e2e 봇", exact: false }).first().click();
    await expect(page.locator(`[data-testid=session-view][data-session="${sid}"]`).first()).toContainText("봇 응답");
    // 기기별 숨김은 실행·목록 데이터와 무관
    await openBots(page);
    const item2 = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" });
    await item2.getByRole("button", { name: "e2e 봇 관리", exact: true }).click();
    await page.getByRole("group", { name: "e2e 봇 관리", exact: true }).getByRole("button", { name: "이 기기에서 숨기기", exact: true }).click();
    await expect(page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" })).toHaveCount(0);
    await selectChoice(page.getByTestId("bots-panel").getByLabel("숨긴 봇 보기"), "true");
    const item3 = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" });
    await expect(item3).toBeVisible();
    // 삭제 → 삭제된 봇 목록에서 복원
    page.on("dialog", (d) => void d.accept());
    await item3.getByRole("button", { name: "e2e 봇 관리", exact: true }).click();
    await page.getByRole("group", { name: "e2e 봇 관리", exact: true }).getByRole("button", { name: "삭제", exact: true }).click();
    await expect(item3).toHaveCount(0);
    await selectChoice(page.getByTestId("bots-panel").getByLabel("삭제된 봇"), "true");
    const del = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" });
    await del.getByRole("button", { name: "e2e 봇 관리", exact: true }).click();
    await page.getByRole("group", { name: "e2e 봇 관리", exact: true }).getByRole("button", { name: "복원", exact: true }).click();
    await selectChoice(page.getByTestId("bots-panel").getByLabel("삭제된 봇"), "false");
    await expect(page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" })).toHaveAttribute("data-status", "active");
});

test("봇 대화 탭을 닫아도 서버 실행은 계속되고 다시 열면 전체 답과 미읽음이 보인다", async ({ page }) => {
    const { a } = await ensureProjects();
    const prof = await ensureProfile();
    const b = await apiCall<{ id: string }>("POST", "/bots", { name: `탭닫기 봇 ${Date.now()}`, project_id: a.id, profile_id: prof });
    const home = await apiCall<{ home_session_id: string; name: string }>("POST", `/bots/${b.id}/home`);
    await login(page);
    await openBots(page);
    const item = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: home.name });
    await item.getByRole("button", { name: home.name, exact: false }).first().click();
    const view = page.locator(`[data-testid=session-view][data-session="${home.home_session_id}"]`).first();
    await script({ frames: frames.text(["느린 ", "봇 ", "끝까지 도착"]), delayMs: 500 });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("천천히");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view).toContainText("실행 중");
    // 탭 닫기: 화면 상태만 바뀌고 서버 턴은 취소되지 않는다
    await page.getByRole("button", { name: "탭 닫기" }).last().click();
    await expect(view).toHaveCount(0);
    await openBots(page);
    await expect(item).not.toContainText("실행 중", { timeout: 15_000 });
    await expect(item.getByTestId("bot-unread")).toBeVisible();
    const turns = await apiCall<{ status: string }[]>("GET", `/sessions/${home.home_session_id}/turns`);
    expect(turns[0]!.status).toBe("completed");
    await item.getByRole("button", { name: home.name, exact: false }).first().click();
    await expect(page.locator(`[data-testid=session-view][data-session="${home.home_session_id}"]`).first()).toContainText("끝까지 도착");
    await expect(item.getByTestId("bot-unread")).toHaveCount(0);
});

test("사용량 패널은 기간·묶음별 token과 가격 미설정 상태를 보여 주고 대화에는 마지막 요청 시간이 보인다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "사용량 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /사용량 대화/ }).first().click();
    const view = page.getByTestId("session-view").first();
    // 의도적인 조회 지연도 수신 이후 화면 반영 시간에 포함된다.
    await page.route("**/api/v1/turns/*", async (route) => {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({ response });
    });
    await page.route(`**/api/v1/sessions/${s.id}/messages?*`, async (route) => {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.fulfill({ response });
    });
    await script({ frames: [...frames.text(["답"]).slice(0, 2), JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }), "[DONE]"] });
    await composerOption(view, "보내기 방식", "model");
    await view.getByLabel("메시지 입력").fill("질문");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("답", { timeout: 15_000 });
    const timing = view.getByTestId("turn-timing");
    await expect(timing).toHaveAttribute("data-running", "false");
    await expect(timing).toContainText("소요 시간");
    await expect(timing).not.toContainText("공급자");
    await timing.getByRole("button", { name: "요청 시간 상세", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "요청 시간 상세" });
    await expect(detail).toContainText("공급자");
    await expect(view.getByTestId("ui-delivery")).toContainText("화면 반영(수신 후)");
    expect(Number((await view.getByTestId("ui-delivery").innerText()).match(/(\d+)ms/)?.[1])).toBeGreaterThanOrEqual(450);
    await page.reload();
    await timing.getByRole("button", { name: "요청 시간 상세", exact: true }).click();
    await expect(detail).toContainText("공급자");
    await expect(view.getByTestId("ui-delivery")).toHaveCount(0);
    await detail.getByRole("button", { name: "닫기", exact: true }).click();
    const panel = await openUsage(page);
    await expect(panel.getByTestId("usage-total")).toContainText("평균 모델 속도");
    await expect(panel.locator('[data-testid^="usage-speed-"]:visible').first()).not.toHaveText("— tok/s");
    await panel.getByRole("button", { name: "실행 현황·추정 비용", exact: true }).click();
    await expect(panel).toContainText("가격 미설정");
    await selectChoice(panel.getByLabel("묶음"), "models");
    await expect(panel.getByTestId("usage-table")).toContainText("fixture-model");
});

test("대화에서 연 설정은 그 대화를 대상으로 저장하고 프로젝트 값은 바꾸지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `범위 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    await openTool(sessionView(page, s.id), "대화");
    await page.locator(`[data-testid=session-view][data-session="${s.id}"]`).first().getByRole("button", { name: "대화 설정" }).click();
    await expect(page.getByTestId("settings-origin").last()).toContainText(title);
    await page.getByLabel("설정 검색").last().fill("요청당 시간 예산");
    const row = page.getByTestId("setting-runs.budget.max_minutes").last();
    await expect(settingsGroupHeader(row)).toContainText(`대화 “${title}”`);
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("10");
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
    await expect(row).toContainText("저장됨");
    await expectChoice(row.getByLabel("요청당 시간 예산(분) 적용 범위"), "session");
    const se = await apiCall<{ items: { key: string; effective: unknown; source: string }[] }>("GET", `/settings/effective?session_id=${s.id}`);
    expect(se.items.find((i) => i.key === "runs.budget.max_minutes")).toMatchObject({ effective: 10, source: "session" });
    const pe = await apiCall<{ items: { key: string; source: string }[] }>("GET", `/settings/effective?project_id=${a.id}`);
    expect(pe.items.find((i) => i.key === "runs.budget.max_minutes")?.source).not.toBe("session");
    // 범위를 바꾸면 대상명도 정확히 바뀐다
    await selectChoice(row.getByLabel("요청당 시간 예산(분) 적용 범위"), "project");
    await expect(settingsGroupHeader(row)).toContainText(`프로젝트 “${a.name}”`);
});

test("다른 pane의 대화가 갱신돼도 열린 설정의 대상과 입력은 바뀌지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const ta = `설정A ${Date.now()}`;
    const tb = `설정B ${Date.now()}`;
    const sa = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: ta });
    const sb = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: tb });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sa.id });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sb.id });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true });
    await recent.getByRole("button", { name: new RegExp(ta) }).first().click();
    // 두 입력창을 먼저 연다. 설정은 pane 내부가 아닌 공용 modal로 표시된다.
    await splitRecentItem(recent.getByTestId("recent-item").filter({ hasText: tb }));
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const right = page.getByTestId("pane").nth(1);
    await right.getByLabel("메시지 입력").fill("오른쪽 입력");
    const left = page.locator(`[data-testid=session-view][data-session="${sa.id}"]`);
    await openTool(left, "대화");
    await left.getByRole("button", { name: "대화 설정" }).click();
    await apiCall("POST", `/sessions/${sb.id}/messages`, { text: "다른 대화의 새 메시지" });
    const settings = page.getByTestId("settings");
    await expect(settings.getByTestId("settings-origin")).toContainText(ta);
    await expect(settings.getByTestId("settings-origin")).not.toContainText(tb);
    await settings.getByLabel("설정 검색").fill("요청당 시간 예산");
    const row = settings.getByTestId("setting-runs.budget.max_minutes");
    await expect(settingsGroupHeader(row)).toContainText(`대화 “${ta}”`);
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("20");
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
    await expect(row).toContainText("저장됨");
    const ea = await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", `/settings/effective?session_id=${sa.id}`);
    const eb = await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", `/settings/effective?session_id=${sb.id}`);
    expect(ea.items.find((i) => i.key === "runs.budget.max_minutes")?.effective).toBe(20);
    expect(eb.items.find((i) => i.key === "runs.budget.max_minutes")?.effective).not.toBe(20);
    await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await expect(right.getByLabel("메시지 입력")).toHaveValue("오른쪽 입력");
});

test("설정 직접 링크는 고급 항목으로 바로 이동한다", async ({ page }) => {
    await login(page);
    await page.evaluate(() => (location.hash = "#setting-context.input_reserve_tokens"));
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("setting-context.input_reserve_tokens")).toBeVisible();
    await expect(page.getByTestId("setting-context.input_reserve_tokens")).toBeInViewport();
});

test("서버 범위 설정은 대상·적용 시점을 보여 주고 저장 후 실제 적용값이 바뀐다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("tab", { name: "데몬 설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("요청당 시간 예산");
    const row = page.getByTestId("setting-runs.budget.max_minutes");
    await expect(settingsGroupHeader(row)).toContainText("서버 전체");
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).fill("30");
    await expect(row).toContainText("저장 안 됨");
    await row.getByLabel("요청당 시간 예산(분)", { exact: true }).blur();
    await expect(row.getByRole("status")).toHaveText("저장됨");
    await expect(row.getByRole("status")).toHaveAccessibleDescription("다음 요청부터 적용");
    await expect(row.getByLabel("요청당 시간 예산(분)", { exact: true })).toHaveValue("30");
    const eff = await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", "/settings/effective");
    expect(eff.items.find((i) => i.key === "runs.budget.max_minutes")?.effective).toBe(30);
    // 고급 항목도 펼치기 없이 메뉴에 바로 보인다
    await page.getByLabel("설정 검색").fill("");
    await page.getByRole("button", { name: "도구·권한", exact: true }).click();
    await expect(page.getByRole("button", { name: /고급 항목 \d+개 펼치기/ })).toHaveCount(0);
    await expect(page.getByTestId("setting-approval.ttl_secs")).toBeVisible();
});
