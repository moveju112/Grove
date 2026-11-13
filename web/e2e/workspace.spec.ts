import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, openDetails, script, sessionView, state } from "./helpers";

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
    await page.getByLabel("토큰").fill("입력-중인-값");
    // 설치·활성화·claim으로 controller가 생길 때까지 기다린다
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await expect(page.getByLabel("토큰")).toHaveValue("입력-중인-값");
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
    const recent = page.locator(".recent");
    await recent.getByRole("button", { name: /A의 대화/ }).click();
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-session", sa.id);
    // B를 오른쪽에 분할로 열기
    await recent.getByTestId("recent-item").filter({ hasText: "B의 대화" }).getByRole("button", { name: "오른쪽에 열기" }).click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    await expect(page.getByTestId("split-row")).toBeVisible();
    const views = page.getByTestId("session-view");
    await expect(views.nth(0)).toHaveAttribute("data-session", sa.id);
    await expect(views.nth(1)).toHaveAttribute("data-session", sb.id);
    // 각 pane에서 메시지 저장 → 원래 세션에만 기록(FLOW-11)
    for (const [i, text] of [[0, "왼쪽에서"], [1, "오른쪽에서"]] as const) {
        const pane = page.getByTestId("pane").nth(i);
        await pane.getByLabel("보내기 방식").selectOption("save");
        await pane.getByLabel("메시지 입력").fill(text);
        await pane.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(pane.getByTestId("msg-user").last()).toHaveText(new RegExp(text));
    }
    const ma = await apiCall<{ items: { content: { text: string } }[] }>("GET", `/sessions/${sa.id}/messages`);
    const mb = await apiCall<{ items: { content: { text: string } }[] }>("GET", `/sessions/${sb.id}/messages`);
    expect(ma.items.map((m) => m.content.text)).toEqual(["왼쪽에서"]);
    expect(mb.items.map((m) => m.content.text)).toEqual(["오른쪽에서"]);
    // 위아래로 전환
    await page.getByRole("separator").dblclick();
    await expect(page.getByTestId("split-column")).toBeVisible();
    // 서버 저장 대기 후 새로고침 → 복원
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(page.getByTestId("split-column")).toBeVisible();
    await expect(page.getByTestId("session-view").nth(1)).toHaveAttribute("data-session", sb.id);
    // 탭 닫기는 화면만 닫는다
    await page.getByTestId("pane").nth(1).getByRole("button", { name: "탭 닫기" }).click();
    await expect(page.getByTestId("pane")).toHaveCount(1);
    const still = await apiCall<{ archived_at: string | null }>("GET", `/sessions/${sb.id}`);
    expect(still.archived_at).toBeNull();
});

test("모델 응답이 중간 표시 후 확정되고, 쓰기 도구 거부 시 파일이 생기지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: "모델 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /모델 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await expect(view).toHaveAttribute("data-session", s.id);
    await script({ frames: frames.text(["천천히 ", "도착하는 ", "답변"]), delayMs: 400 });
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("메시지 입력").fill("답해줘");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("partial")).toBeVisible();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("천천히 도착하는 답변", { timeout: 15_000 });
    await expect(view.getByTestId("partial")).toHaveCount(0);

    // 도구: 쓰기 요청 → 승인 카드 → 거부
    await script({ frames: frames.tool("w1", "write", { path: "made.txt", content: "x" }) });
    await script({ frames: frames.text(["거부 확인"]) });
    await view.getByLabel("도구").check();
    await view.getByLabel("메시지 입력").fill("파일 만들어");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const card = view.getByTestId("approval");
    await expect(card).toContainText("made.txt", { timeout: 15_000 });
    await card.getByRole("button", { name: "거부" }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("거부 확인", { timeout: 15_000 });
    expect(existsSync(join(state().projA, "made.txt"))).toBe(false);

    // 이 대화에서 계속 허용 → 다음 write는 승인 카드 없이 실행되고 범위가 표시된다
    await script({ frames: frames.tool("w2", "write", { path: "granted1.txt", content: "1" }) });
    await script({ frames: frames.text(["첫 쓰기"]) });
    await view.getByLabel("메시지 입력").fill("파일 하나");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(card).toContainText("granted1.txt", { timeout: 15_000 });
    await card.getByRole("button", { name: "이 대화에서 계속 허용" }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("첫 쓰기", { timeout: 15_000 });
    await script({ frames: frames.tool("w3", "write", { path: "granted2.txt", content: "2" }) });
    await script({ frames: frames.text(["둘째 쓰기"]) });
    await view.getByLabel("메시지 입력").fill("파일 둘");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("둘째 쓰기", { timeout: 15_000 });
    expect(existsSync(join(state().projA, "granted2.txt"))).toBe(true);
    await expect(view.getByTestId("approval-scope").last()).toHaveText(/이 대화에서 허용됨/);
    // UI-014: 도구 카드에 인자·소요 시간·결과를 표시한다
    const tool = view.getByTestId("msg-tool").last();
    await expect(tool.getByTestId("tool-duration")).toHaveText(/\d+(ms|\.\d초)/);
    await tool.locator("summary").click();
    await expect(tool.getByTestId("tool-args")).toContainText("granted2.txt");
    await expect(tool.getByTestId("tool-output")).toBeVisible();
    await expect(tool.getByTestId("tool-truncated")).toHaveCount(0);
    await view.getByLabel("도구").uncheck();
});

test("자식 에이전트 위임을 승인하면 자식 대화가 생기고 결과가 부모 대화에 한 번 보고된다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: "위임 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /위임 대화/ }).first().click();
    // 뒤에서 자식 대화가 두 번째 pane에 열리므로 부모 화면을 첫 pane으로 고정한다.
    const view = page.getByTestId("session-view").first();
    await expect(view).toHaveAttribute("data-session", s.id);
    const prompt = `검토 맡겨 ${s.id}`;
    await script({ frames: frames.tool("a1", "agent", { action: "spawn", agent_id: "reviewer", brief: "변경을 검토해" }), marker: prompt });
    await script({ frames: frames.text(["검토를 맡겼어"]), marker: prompt });
    await script({ frames: frames.text(["자식 검토 결과를 확인했어"]), marker: prompt });
    await script({ frames: frames.text(["자식 검토 결과: 이상 없음"]), delayMs: 200, marker: "Delegated task" });
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("도구").check();
    await view.getByLabel("메시지 입력").fill(prompt);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    const card = view.getByTestId("approval");
    await expect(card).toContainText("reviewer", { timeout: 15_000 });
    // 위임은 대화 범위로 허용할 수 없다(일회 승인만)
    await expect(card.getByRole("button", { name: "이 대화에서 계속 허용" })).toHaveCount(0);
    await card.getByRole("button", { name: "이번만 승인" }).click();
    await expect(view.getByTestId("msg-agent-result")).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("msg-agent-result")).toContainText("자식 검토 결과: 이상 없음");
    await expect(view.getByTestId("turn-status")).toHaveCount(0);
    const turns = await apiCall<{ status: string; error: unknown }[]>("GET", `/sessions/${s.id}/turns`);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("completed");
    expect(turns[0]!.error).toBeNull();
    const runs = view.getByTestId("agent-runs");
    // 진행 중에 자동으로 열린 목록은 끝나도 열린 채 남는다. 상태가 확정된 뒤 닫혀 있을 때만 연다.
    await expect(runs.getByTestId("agent-run").first()).toHaveAttribute("data-status", "completed");
    await openDetails(runs.locator("details"));
    // 자식 대화를 열면 부모 연결이 보인다
    await runs.getByRole("button", { name: "자식 대화" }).first().click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const child = page.getByTestId("session-view").nth(1);
    await expect(child.getByTestId("agent-runs")).toContainText("부모 대화 열기");
    await expect(child.getByTestId("msg-who").first()).toHaveText("부모 에이전트의 지시");
    await expect(child.getByTestId("msg-assistant").last()).toContainText("자식 검토 결과");
    await view.getByLabel("도구").uncheck();
});

test("Goal을 추가·완료·순서 변경하고 다른 화면의 변경이 실시간 반영된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "Goal 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /Goal 대화/ }).first().click();
    const panel = page.getByTestId("goals-panel");
    await panel.locator("summary").click();
    for (const t of ["첫째", "둘째"]) {
        await panel.getByLabel("새 Goal").fill(t);
        await panel.getByRole("button", { name: "추가" }).click();
        await expect(panel.getByTestId("goal").filter({ hasText: t })).toHaveCount(1);
    }
    await panel.getByRole("button", { name: "둘째 위로" }).click();
    await expect(panel.getByTestId("goal").first()).toContainText("둘째");
    await panel.getByTestId("goal").filter({ hasText: "첫째" }).getByRole("checkbox").check();
    await expect(panel.getByTestId("goal").filter({ hasText: "첫째" })).toHaveAttribute("data-status", "done");
    await expect(panel.locator("summary")).toContainText("남은 1/2");
    // 다른 기기(API)에서 추가하면 이벤트로 반영
    await apiCall("POST", `/sessions/${s.id}/goals`, { title: "밖에서 추가" });
    await expect(panel.getByTestId("goal").filter({ hasText: "밖에서 추가" })).toHaveCount(1);
});

test("Git 변경에서 hunk 하나만 올리고 커밋하면 나머지 변경은 작업 트리에 남는다", async ({ page }) => {
    const { b } = await ensureProjects();
    const proj = await apiCall<{ root_path: string }>("GET", `/projects/${b.id}`);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: proj.root_path, encoding: "utf8" });
    if (!existsSync(join(proj.root_path, ".git"))) {
        run("init", "-q", "-b", "main");
        run("config", "user.email", "e2e@example.invalid");
        run("config", "user.name", "E2E");
    }
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}\n`);
    writeFileSync(join(proj.root_path, "h.txt"), lines.join(""));
    run("add", "h.txt");
    run("commit", "-qm", "base");
    lines[1] = "LINE2\n";
    lines[27] = "LINE28\n";
    writeFileSync(join(proj.root_path, "h.txt"), lines.join(""));
    await login(page);
    await page.getByRole("button", { name: b.name, exact: true }).first().click();
    const wrap = page.locator(".git-wrap");
    await wrap.locator("summary").first().click();
    const panel = page.getByTestId("git-panel");
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
    await page.locator(".recent").getByRole("button", { name: /압축 대화/ }).first().click();
    const view = page.getByTestId("session-view").first();
    await view.getByLabel("보내기 방식").selectOption("model");
    // 요약이 원문보다 짧아야 적용되므로(CMP-006) 첫 답은 요약보다 길게 둔다
    for (const [q, ans] of [["첫 질문", `첫 답 ${"자세한 설명 ".repeat(20)}`], ["둘째 질문", "둘째 답"]]) {
        await script({ frames: frames.text([ans!]) });
        await view.getByLabel("메시지 입력").fill(q!);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText(ans!, { timeout: 15_000 });
    }
    const meter = view.getByTestId("context-meter");
    await expect(meter).toContainText("context");
    await expect(meter).toContainText("(추정)");
    await script({ frames: frames.text(["요약: 첫 질문에 답했다"]), marker: "You compress a conversation" });
    await meter.getByRole("button", { name: "압축" }).click();
    await expect(view.getByTestId("msg-compaction")).toHaveCount(1, { timeout: 15_000 });
    await expect(view.getByTestId("msg-compaction")).toContainText("수동 압축");
    // CMP-011: 적용 구간과 원문 보존을 함께 보여 준다
    await view.getByTestId("msg-compaction").locator("summary").click();
    await expect(view.getByTestId("compaction-source")).toContainText("원문은 화면 이력에 그대로 남습니다");
    // 화면 이력은 그대로 남는다
    await expect(view.getByTestId("msg-assistant").first()).toContainText("첫 답");
});

test("서버 protocol이 바뀌면 새로고침을 안내하고 변경 요청을 보내지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    await login(page);
    let mutations = 0;
    // 서버만 먼저 업데이트된 상황: 응답 protocol을 다른 값으로 바꾼다
    await page.route("**/api/v1/**", async (route) => {
        if (route.request().method() !== "GET") mutations++;
        const r = await route.fetch();
        await route.fulfill({ response: r, headers: { ...r.headers(), "x-grove-protocol": "999" } });
    });
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await expect(page.getByTestId("protocol-banner")).toBeVisible();
    await expect(page.getByTestId("protocol-banner")).toContainText("protocol 999");
    // 변경 요청(새 대화)은 클라이언트에서 막힌다
    const view = page.locator(".project-view").first();
    await view.getByLabel("보내기 방식").selectOption("save");
    await view.getByLabel("메시지 입력").fill("보내지면 안 됨");
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
    await view.getByLabel("메시지 입력").press("Control+Enter");
    await expect(view.getByLabel("메시지 입력")).toHaveValue("보내지면 안 됨");
    expect(mutations).toBe(0);
    await page.unroute("**/api/v1/**");
});

test("입력 중 초안은 새로고침 후 복원되고 서버 초안 충돌을 알린다", async ({ page }) => {
    const { b } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: "초안 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /초안 대화/ }).first().click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("메시지 입력").fill("아직 안 보낸 글");
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(page.getByTestId("session-view").getByLabel("메시지 입력")).toHaveValue("아직 안 보낸 글");
    // 다른 기기가 서버 초안을 먼저 저장
    await apiCall("PUT", `/drafts/session:${s.id}`, { expected_revision: 0, text: "폰에서 쓴 글", device_name: "Android" });
    await page.getByTestId("session-view").getByRole("button", { name: "초안 서버 저장" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "다른 기기(Android)" })).toBeVisible();
    // 내 초안은 그대로
    await expect(page.getByTestId("session-view").getByLabel("메시지 입력")).toHaveValue("아직 안 보낸 글");
    await page.getByRole("button", { name: "합치기" }).click();
    await expect(page.getByTestId("session-view").getByLabel("메시지 입력")).toHaveValue("아직 안 보낸 글\n\n폰에서 쓴 글");
});

test("설정 검색은 항목과 적용 범위를 보여 주고 기본 에이전트 수정·복원을 할 수 있다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("테마");
    await expect(page.getByTestId("setting-theme")).toContainText("이 기기");
    await expect(page.getByTestId("setting-secrets")).toHaveCount(0);
    await page.getByLabel("설정 검색").fill("");
    await page.getByRole("button", { name: "에이전트·워크플로우" }).click();
    // 사이드바 세션 목록에도 "Reviewer: …" 대화가 보일 수 있어 설정 정의 영역으로 범위를 좁힌다.
    await page.getByTestId("setting-definitions").getByRole("button", { name: /^Reviewer/ }).click();
    const editor = page.getByLabel("정의 본문");
    const original = await editor.inputValue();
    await editor.fill(original + "\n추가 지침");
    await page.getByTestId("setting-definitions").getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByTestId("setting-definitions").getByText("저장됨")).toBeVisible();
    const d =await apiCall<{ modified_fields: string[]; revision: number }>("GET", "/definitions/agent/reviewer");
    expect(d.modified_fields).toEqual(["body"]);
    page.once("dialog", (dlg) => dlg.accept());
    await page.getByRole("button", { name: "기본값 복원" }).click();
    await expect.poll(async () => (await apiCall<{ modified_fields: string[] }>("GET", "/definitions/agent/reviewer")).modified_fields).toEqual([]);
});

test("파일 화면에서 열고 고쳐 저장하며, 외부 변경은 충돌로 알리고 내 편집을 지키며, 이미지는 티켓으로 미리 본다", async ({ page }) => {
    const { a } = await ensureProjects();
    const proj = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    writeFileSync(join(proj.root_path, "note.md"), "처음\n");
    // 1x1 PNG
    writeFileSync(join(proj.root_path, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await page.getByRole("button", { name: "파일", exact: true }).click();
    const files = page.getByTestId("files-view");
    await files.getByRole("button", { name: "note.md" }).click();
    const editor = files.getByLabel("파일 내용");
    await expect(editor).toHaveValue("처음\n");
    await editor.fill("고침\n");
    await expect(files.getByText("● 저장 안 됨")).toBeVisible();
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status")).toHaveText("저장됨");
    expect(readFileSync(join(proj.root_path, "note.md"), "utf8")).toBe("고침\n");
    // 외부 변경 뒤 저장 → 충돌, 파일과 내 편집 모두 보존
    writeFileSync(join(proj.root_path, "note.md"), "밖에서 바꿈\n");
    await editor.fill("내 편집\n");
    await files.getByRole("button", { name: "저장", exact: true }).click();
    await expect(files.getByRole("status")).toContainText("파일이 바뀌었습니다");
    await expect(editor).toHaveValue("내 편집\n");
    expect(readFileSync(join(proj.root_path, "note.md"), "utf8")).toBe("밖에서 바꿈\n");
    // 이미지 미리보기: 인증 헤더 없이 티켓 URL로 실제로 그려진다
    await files.getByRole("button", { name: "dot.png" }).click();
    const img = files.locator("img.preview");
    await expect(img).toHaveAttribute("src", /\/api\/v1\/file-tickets\//);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
});

test("백그라운드 작업을 시작·취소하고 결과가 대화에 한 번 기록된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const sess = await apiCall<{ id: string; title: string }>("POST", `/projects/${a.id}/sessions`, { title: "작업 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sess.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /작업 대화/ }).first().click();
    // 앞선 시험이 분할 배치를 남겼을 수 있어 이 대화 화면 안에서만 찾는다.
    const view = sessionView(page, sess.id);
    const panel = view.getByTestId("tasks-panel");
    await openDetails(panel);
    await panel.getByLabel("백그라운드 명령").fill("echo 백그라운드-완료");
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(view.getByTestId("msg-task-result")).toHaveCount(1);
    await expect(view.getByTestId("msg-task-result")).toContainText("completed");
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
    await expect(view.getByTestId("msg-task-result")).toHaveCount(2);
});

test("터미널을 열어 입력·출력하고, 새로고침하면 화면이 복원되며, 종료하면 읽기 전용이 된다", async ({ page }) => {
    const { a } = await ensureProjects();
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const list = page.getByTestId("terminal-list");
    await openDetails(list);
    await list.getByRole("button", { name: "새 터미널" }).click();
    const view = page.getByTestId("terminal-view");
    await expect(view).toHaveAttribute("data-conn", "open");
    await view.locator(".xterm").click();
    await page.keyboard.type("echo e2e-$((20+22))");
    await page.keyboard.press("Enter");
    await expect(view.locator(".xterm-rows")).toContainText("e2e-42");
    // 새로고침 → 레이아웃 복원 + snapshot으로 이전 출력 복원
    await page.reload();
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-conn", "open");
    await expect(page.getByTestId("terminal-view").locator(".xterm-rows")).toContainText("e2e-42");
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("terminal-view").getByRole("button", { name: "종료" }).click();
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-conn", "readonly");
    await expect(page.getByTestId("terminal-status")).toContainText("종료됨");
    await expect(page.getByTestId("terminal-view").locator(".xterm-rows")).toContainText("e2e-42");
});

test("봇을 만들고 home 대화에서 답을 받고, 새로고침·분할 뒤에도 같은 대화이며 초기화·삭제·복원을 할 수 있다", async ({ page }) => {
    await ensureProjects();
    await ensureProfile();
    await login(page);
    const panel = page.getByTestId("bots-panel");
    await panel.getByRole("button", { name: "+ 봇" }).click();
    const ed = panel.getByTestId("bot-editor");
    await ed.getByLabel("봇 이름").fill("e2e 봇");
    await ed.getByLabel("persona").fill("짧게 답한다");
    await ed.getByRole("button", { name: "봇 만들기" }).click();
    const item = panel.getByTestId("bot").filter({ hasText: "e2e 봇" });
    await expect(item).toContainText("모델 없음");
    // 모델 설정
    await item.getByLabel("e2e 봇 관리").click();
    await item.getByRole("button", { name: "편집" }).click();
    await panel.getByTestId("bot-editor").getByLabel("봇 모델").selectOption({ index: 1 });
    await panel.getByTestId("bot-editor").getByRole("button", { name: "저장" }).click();
    await expect(item).not.toContainText("모델 없음");
    // home 대화
    await item.locator(".bot-open").click();
    const view = page.getByTestId("session-view").last();
    await expect(view.getByTestId("bot-chip")).toBeVisible();
    const sid = await view.getAttribute("data-session");
    await script({ frames: frames.text(["봇 응답"]) });
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("메시지 입력").fill("안녕");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("봇 응답", { timeout: 15_000 });
    // 새로고침 뒤 다시 열어도 같은 대화
    await page.reload();
    await page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" }).locator(".bot-open").click();
    await expect(page.locator(`[data-testid=session-view][data-session="${sid}"]`).first()).toContainText("봇 응답");
    // 기기별 숨김은 실행·목록 데이터와 무관
    const item2 = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" });
    await item2.getByLabel("e2e 봇 관리").click();
    await item2.getByRole("button", { name: "이 기기에서 숨기기" }).click();
    await expect(page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" })).toHaveCount(0);
    await page.getByTestId("bots-panel").getByLabel("숨긴 봇 보기").check();
    const item3 = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" });
    await expect(item3).toBeVisible();
    // 삭제 → 삭제된 봇 목록에서 복원
    page.on("dialog", (d) => void d.accept());
    await item3.getByLabel("e2e 봇 관리").click();
    await item3.getByRole("button", { name: "삭제" }).click();
    await expect(item3).toHaveCount(0);
    await page.getByTestId("bots-panel").getByLabel("삭제된 봇").check();
    const del = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" });
    await del.getByLabel("e2e 봇 관리").click();
    await del.getByRole("button", { name: "복원" }).click();
    await page.getByTestId("bots-panel").getByLabel("삭제된 봇").uncheck();
    await expect(page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: "e2e 봇" })).toHaveAttribute("data-status", "active");
});

test("봇 대화 탭을 닫아도 서버 실행은 계속되고 다시 열면 전체 답과 미읽음이 보인다", async ({ page }) => {
    const { a } = await ensureProjects();
    const prof = await ensureProfile();
    const b = await apiCall<{ id: string }>("POST", "/bots", { name: `탭닫기 봇 ${Date.now()}`, project_id: a.id, profile_id: prof });
    const home = await apiCall<{ home_session_id: string; name: string }>("POST", `/bots/${b.id}/home`);
    await login(page);
    const item = page.getByTestId("bots-panel").getByTestId("bot").filter({ hasText: home.name });
    await item.locator(".bot-open").click();
    const view = page.locator(`[data-testid=session-view][data-session="${home.home_session_id}"]`).first();
    await script({ frames: frames.text(["느린 ", "봇 ", "끝까지 도착"]), delayMs: 500 });
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("메시지 입력").fill("천천히");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(item).toContainText("실행 중");
    // 탭 닫기: 화면 상태만 바뀌고 서버 턴은 취소되지 않는다
    await page.getByRole("button", { name: "탭 닫기" }).last().click();
    await expect(view).toHaveCount(0);
    await expect(item).not.toContainText("실행 중", { timeout: 15_000 });
    await expect(item.getByTestId("bot-unread")).toBeVisible();
    const turns = await apiCall<{ status: string }[]>("GET", `/sessions/${home.home_session_id}/turns`);
    expect(turns[0]!.status).toBe("completed");
    await item.locator(".bot-open").click();
    await expect(page.locator(`[data-testid=session-view][data-session="${home.home_session_id}"]`).first()).toContainText("끝까지 도착");
    await expect(item.getByTestId("bot-unread")).toHaveCount(0);
});

test("대화 검색은 본문 발췌를 보여 주고 결과를 누르면 그 대화를 연다", async ({ page }) => {
    const { a } = await ensureProjects();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "검색 대상" });
    const word = `zebra${Date.now()}`;
    await apiCall("POST", `/sessions/${s.id}/messages`, { text: `여기에 ${word} 가 있다` });
    await login(page);
    const panel = page.getByTestId("search-panel");
    await panel.locator("summary").click();
    await panel.getByLabel("대화 검색어").fill(word);
    const hit = panel.getByTestId("search-hit");
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText(word);
    await panel.getByLabel("본문 포함").uncheck();
    await expect(panel.getByTestId("search-total")).toHaveText("0개");
    await panel.getByLabel("본문 포함").check();
    await hit.click();
    await expect(page.locator(`[data-testid=session-view][data-session="${s.id}"]`).first()).toContainText(word);
});

test("예약을 만들고 지금 실행하면 실행 기록과 영속 알림이 생기고 알림에서 대화를 연다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const panel = page.getByTestId("schedules-panel");
    await panel.locator("summary").first().click();
    await panel.getByLabel("예약 이름").fill("e2e 점검");
    await panel.getByLabel("예약 지시").fill("상태 알려줘");
    await panel.getByLabel("예약 방식").selectOption("interval");
    await panel.getByLabel("간격(분)").fill("600");
    await panel.getByRole("button", { name: "예약 추가" }).click();
    const item = panel.getByTestId("schedule").filter({ hasText: "e2e 점검" });
    await expect(item).toContainText("600분마다");
    await expect(item).toContainText("활성");
    await script({ frames: frames.text(["예약 결과 보고"]) });
    await item.locator("summary").click();
    await item.getByRole("button", { name: "지금 실행" }).click();
    await expect(item.getByTestId("schedule-runs")).toContainText("완료", { timeout: 15_000 });
    // 일시 정지
    await item.getByRole("button", { name: "일시 정지" }).click();
    await expect(item.locator("summary").first()).toContainText("일시 정지");
    // 알림은 서버에 남고 사이드바에서 보인다. 누르면 실행한 대화를 연다
    const notes = page.getByTestId("notifications");
    await expect(notes.getByTestId("notifications-unread")).toBeVisible();
    await notes.locator("summary").click();
    await notes.getByTestId("notification").filter({ hasText: "e2e 점검" }).first().click();
    await expect(page.getByTestId("session-view").last()).toContainText("예약 결과 보고");
});

// RTE-002·009: 담당 봇 예약은 범위를 확인해야 저장되고, 일시 정지로 저장하면 실행하지 않으며 결과는 봇 대화에 예약 출처로 남는다.
test("담당 봇 예약은 범위 확인 뒤 저장하고 결과를 봇 대화에 예약 출처로 남긴다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const stamp = Date.now().toString(36);
    const bot = await apiCall<{ id: string; name: string }>("POST", "/bots", { name: `예약봇 ${stamp}`, project_id: a.id, profile_id: profile });
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const panel = page.getByTestId("schedules-panel");
    await panel.locator("summary").first().click();
    await panel.getByLabel("예약 이름").fill(`봇 점검 ${stamp}`);
    await panel.getByLabel("예약 지시").fill("상태 알려줘");
    await panel.getByLabel("예약 방식").selectOption("interval");
    await panel.getByLabel("간격(분)").fill("600");
    await panel.getByLabel("담당 봇").selectOption(bot.id);
    await expect(panel.getByLabel("예약 모델")).toBeDisabled();
    const confirmBox = panel.getByTestId("schedule-confirm");
    await expect(confirmBox).toContainText(bot.name);
    await expect(confirmBox).toContainText("600분마다");
    const add = panel.getByRole("button", { name: "예약 추가" });
    await expect(add).toBeDisabled();
    await confirmBox.getByLabel("위 범위를 확인했습니다").check();
    await confirmBox.getByLabel("저장만 하고 일시 정지 상태로 둠").check();
    await add.click();
    const item = panel.getByTestId("schedule").filter({ hasText: `봇 점검 ${stamp}` });
    await expect(item.locator("summary").first()).toContainText("일시 정지");
    await item.locator("summary").first().click();
    await expect(item.getByTestId("schedule-bot")).toContainText(bot.name);
    await expect(item).toContainText("아직 실행 기록이 없습니다");
    await script({ frames: frames.text(["봇 예약 결과"]) });
    await item.getByRole("button", { name: "지금 실행" }).click();
    await expect(item.getByTestId("schedule-runs")).toContainText("완료", { timeout: 15_000 });
    await item.getByRole("button", { name: "대화 열기" }).click();
    const view = page.getByTestId("session-view").last();
    await expect(view).toContainText(`예약 '봇 점검 ${stamp}' 실행`);
    await expect(view).toContainText("봇 예약 결과");
});

// RTE-004·005: 화면에서 webhook을 켜면 비밀을 한 번 보여 주고, 서명한 요청은 한 번만 실행하며 재전송은 같은 실행을 돌려준다.
test("예약 webhook을 켜고 서명한 요청으로 한 번만 실행한다", async ({ page, request, baseURL }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const stamp = Date.now().toString(36);
    const sch = await apiCall<{ id: string }>("POST", `/projects/${a.id}/schedules`, { name: `훅 예약 ${stamp}`, prompt: "알려줘", profile_id: profile, kind: "interval", interval_minutes: 600 });
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const panel = page.getByTestId("schedules-panel");
    await panel.locator("summary").first().click();
    const item = panel.getByTestId("schedule").filter({ hasText: `훅 예약 ${stamp}` });
    await item.locator("summary").first().click();
    const hook = item.getByTestId("schedule-webhook");
    await expect(hook).toContainText("webhook 꺼짐");
    await hook.getByRole("button", { name: "webhook 켜기" }).click();
    const secret = (await hook.getByTestId("webhook-secret").textContent())!;
    expect(secret).toMatch(/^gwh_/);
    await expect(hook).toContainText("webhook 켜짐");
    await script({ frames: frames.text(["훅 결과"]) });
    const send = async () => {
        const ts = Math.floor(Date.now() / 1000).toString();
        const body = JSON.stringify({ stamp });
        const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.evt-${stamp}.${body}`).digest("hex");
        return request.post(`${baseURL}/api/v1/hooks/schedules/${sch.id}`, { headers: { "X-Grove-Timestamp": ts, "X-Grove-Event-Id": `evt-${stamp}`, "X-Grove-Signature": sig, "Content-Type": "application/json" }, data: body });
    };
    const first = await send();
    expect(first.status()).toBe(202);
    await expect(item.getByTestId("schedule-runs")).toContainText("완료", { timeout: 15_000 });
    const again = await send();
    expect(again.status()).toBe(200);
    expect((await again.json()).run_id).toBe((await first.json()).run_id);
    await expect(item.getByTestId("schedule-runs").locator("li")).toHaveCount(1);
});

// QUIET-005·008: 화면에서 조용한 종료를 켜면 같은 결과의 자동 실행은 알림 없이 기록되고, 생략된 것은 알림뿐임을 보여 준다.
test("결과가 같으면 알림을 생략하고 실행 기록에 변화 없음·알림 생략을 표시한다", async ({ page, request, baseURL }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const stamp = Date.now().toString(36);
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const panel = page.getByTestId("schedules-panel");
    await panel.locator("summary").first().click();
    await panel.getByLabel("예약 이름").fill(`조용 ${stamp}`);
    await panel.getByLabel("예약 지시").fill("상태 알려줘");
    await panel.getByLabel("예약 방식").selectOption("interval");
    await panel.getByLabel("간격(분)").fill("600");
    await panel.getByLabel("결과가 직전과 같으면 알림 생략").check();
    await panel.getByRole("button", { name: "예약 추가" }).click();
    const item = panel.getByTestId("schedule").filter({ hasText: `조용 ${stamp}` });
    await item.locator("summary").first().click();
    await expect(item).toContainText("직전 완료 결과와 같으면 자동 실행 알림을 생략");
    await item.getByTestId("schedule-webhook").getByRole("button", { name: "webhook 켜기" }).click();
    const secret = (await item.getByTestId("webhook-secret").textContent())!;
    const id = (await apiCall<{ id: string; name: string }[]>("GET", `/schedules?project_id=${a.id}`)).find((s) => s.name === `조용 ${stamp}`)!.id;
    const send = async (event: string) => {
        const ts = Math.floor(Date.now() / 1000).toString();
        const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${event}.{}`).digest("hex");
        const r = await request.post(`${baseURL}/api/v1/hooks/schedules/${id}`, { headers: { "X-Grove-Timestamp": ts, "X-Grove-Event-Id": event, "X-Grove-Signature": sig }, data: "{}" });
        expect(r.status()).toBe(202);
    };
    const runs = item.getByTestId("schedule-runs").locator("li");
    await script({ frames: frames.text(["이상 없음"]) });
    await send(`a-${stamp}`);
    await expect(runs.first()).toContainText("변화 있음", { timeout: 15_000 });
    await script({ frames: frames.text(["이상 없음"]) });
    await send(`b-${stamp}`);
    await expect(runs).toHaveCount(2, { timeout: 15_000 });
    await expect(item.getByTestId("schedule-runs")).toContainText("변화 없음", { timeout: 15_000 });
    await expect(item.getByTestId("schedule-runs")).toContainText("알림 생략(실행·비용은 발생)");
    const notes = await apiCall<{ items: { title: string }[] }>("GET", "/notifications");
    expect(notes.items.filter((n) => n.title.includes(`조용 ${stamp}`))).toHaveLength(1);
});

// AUTO-009: 반복 한도를 화면에서 정하고, 연속 실패로 자동 정지된 예약은 이유와 실패 수를 보여 주며 재개할 수 있다.
test("예약에 최대 횟수·연속 실패 정지를 정하고, 실패로 자동 정지되면 이유를 보여 주고 재개한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const stamp = Date.now();
    await apiCall("POST", `/projects/${a.id}/schedules`, {
        name: `실패 예약 ${stamp}`, prompt: "길게 말해", profile_id: profile, kind: "interval", interval_minutes: 600, max_total_tokens: 5, pause_after_failures: 1,
    });
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    const panel = page.getByTestId("schedules-panel");
    await panel.locator("summary").first().click();
    await panel.getByLabel("예약 이름").fill(`한도 예약 ${stamp}`);
    await panel.getByLabel("예약 지시").fill("상태 알려줘");
    await panel.getByLabel("예약 방식").selectOption("interval");
    await panel.getByLabel("간격(분)").fill("600");
    await panel.getByLabel("최대 실행 횟수").fill("3");
    await panel.getByLabel("연속 실패 시 정지").fill("2");
    await panel.getByRole("button", { name: "예약 추가" }).click();
    const limited = panel.getByTestId("schedule").filter({ hasText: `한도 예약 ${stamp}` });
    await limited.locator("summary").click();
    await expect(limited.getByTestId("schedule-limits")).toHaveText("자동 실행 0/3회 · 연속 2회 실패 시 자동 정지");
    const failing = panel.getByTestId("schedule").filter({ hasText: `실패 예약 ${stamp}` });
    await failing.locator("summary").click();
    // 사용량을 보고해야 token 한도(5)를 넘은 실패가 된다.
    await script({ frames: [...frames.text(["예산을 넘는 긴 답"]).slice(0, 2), JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }), "[DONE]"] });
    await failing.getByRole("button", { name: "지금 실행" }).click();
    await expect(failing.getByTestId("schedule-runs")).toContainText("실패", { timeout: 15_000 });
    await expect(failing.locator("summary").first()).toContainText("일시 정지(연속 실패)");
    await expect(failing.getByTestId("schedule-limits")).toContainText("연속 실패 1회");
    await failing.getByRole("button", { name: "재개" }).click();
    await expect(failing.locator("summary").first()).toContainText("활성");
    await expect(failing.getByTestId("schedule-limits")).not.toContainText("연속 실패 1회");
});

test("사용량 패널은 기간·묶음별 token과 가격 미설정 상태를 보여 주고 대화에는 마지막 요청 시간이 보인다", async ({ page }) => {
    const { a } = await ensureProjects();
    await ensureProfile();
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: "사용량 대화" });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: /사용량 대화/ }).first().click();
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
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("메시지 입력").fill("질문");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").last()).toContainText("답", { timeout: 15_000 });
    await expect(view.getByTestId("turn-timing")).toContainText("마지막 요청");
    await expect(view.getByTestId("turn-timing")).toContainText("공급자");
    await expect(view.getByTestId("ui-delivery")).toContainText("화면 반영(수신 후)");
    expect(Number((await view.getByTestId("ui-delivery").innerText()).match(/(\d+)ms/)?.[1])).toBeGreaterThanOrEqual(450);
    await page.reload();
    await expect(view.getByTestId("turn-timing")).toContainText("공급자");
    await expect(view.getByTestId("ui-delivery")).toHaveCount(0);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("사용량");
    const panel = page.getByTestId("usage-panel");
    await expect(panel.getByTestId("usage-total")).toContainText("응답");
    await expect(panel.getByTestId("usage-total")).toContainText("가격 미설정");
    await panel.getByLabel("묶음").selectOption("model");
    await expect(panel.getByTestId("usage-table")).toContainText("가격 미설정");
});

test("대화에서 연 설정은 그 대화를 대상으로 저장하고 프로젝트 값은 바꾸지 않는다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `범위 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    await page.locator(`[data-testid=session-view][data-session="${s.id}"]`).first().getByRole("button", { name: "대화 설정" }).click();
    await expect(page.getByTestId("settings-origin").last()).toContainText(title);
    await page.getByLabel("설정 검색").last().fill("응답 언어");
    const row = page.getByTestId("setting-output.language").last();
    await expect(row).toContainText(`대상: 대화 “${title}”`);
    await row.getByLabel("응답 언어", { exact: true }).fill("English");
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row).toContainText("저장됨");
    await expect(row).toContainText("(이 대화)");
    const se = await apiCall<{ items: { key: string; effective: unknown; source: string }[] }>("GET", `/settings/effective?session_id=${s.id}`);
    expect(se.items.find((i) => i.key === "output.language")).toMatchObject({ effective: "English", source: "session" });
    const pe = await apiCall<{ items: { key: string; source: string }[] }>("GET", `/settings/effective?project_id=${a.id}`);
    expect(pe.items.find((i) => i.key === "output.language")?.source).not.toBe("session");
    // 범위를 바꾸면 대상명도 정확히 바뀐다
    await row.getByLabel("응답 언어 적용 범위").selectOption("project");
    await expect(row).toContainText(`대상: 프로젝트 “${a.name}”`);
});

test("다른 pane에서 다른 대화를 열고 조작해도 열어 둔 설정의 대상은 바뀌지 않는다", async ({ page }) => {
    const { a, b } = await ensureProjects();
    const ta = `설정A ${Date.now()}`;
    const tb = `설정B ${Date.now()}`;
    const sa = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: ta });
    const sb = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: tb });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: sa.id });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: sb.id });
    await login(page);
    const recent = page.locator(".recent");
    await recent.getByRole("button", { name: new RegExp(ta) }).first().click();
    await page.locator(`[data-testid=session-view][data-session="${sa.id}"]`).getByRole("button", { name: "대화 설정" }).click();
    const left = page.getByTestId("pane").nth(0);
    await expect(left.getByTestId("settings-origin")).toContainText(ta);
    // B를 오른쪽 pane에 열고 그쪽을 조작한다
    await recent.getByTestId("recent-item").filter({ hasText: tb }).getByRole("button", { name: "오른쪽에 열기" }).click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const right = page.getByTestId("pane").nth(1);
    await right.getByLabel("메시지 입력").fill("오른쪽 입력");
    // 왼쪽 설정은 여전히 A 대상
    await expect(left.getByTestId("settings-origin")).toContainText(ta);
    await expect(left.getByTestId("settings-origin")).not.toContainText(tb);
    await left.getByLabel("설정 검색").fill("응답 언어");
    const row = left.getByTestId("setting-output.language");
    await expect(row).toContainText(`대상: 대화 “${ta}”`);
    await row.getByLabel("응답 언어", { exact: true }).fill("日本語");
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row).toContainText("저장됨");
    const ea = await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", `/settings/effective?session_id=${sa.id}`);
    const eb = await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", `/settings/effective?session_id=${sb.id}`);
    expect(ea.items.find((i) => i.key === "output.language")?.effective).toBe("日本語");
    expect(eb.items.find((i) => i.key === "output.language")?.effective).not.toBe("日本語");
});

test("설정 직접 링크는 접힌 고급 항목도 펼쳐서 보여 준다", async ({ page }) => {
    await login(page);
    await page.evaluate(() => (location.hash = "#setting-context.input_reserve_tokens"));
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("setting-context.input_reserve_tokens")).toBeVisible();
    await expect(page.getByTestId("setting-context.input_reserve_tokens")).toBeInViewport();
});

test("서버 범위 설정은 대상·적용 시점을 보여 주고 저장 후 실제 적용값이 바뀐다", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("응답 언어");
    const row = page.getByTestId("setting-output.language");
    await expect(row).toContainText("대상: 서버 전체");
    await row.getByLabel("응답 언어", { exact: true }).fill("한국어");
    await expect(row).toContainText("저장 안 됨");
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row).toContainText("저장됨 · 다음 요청부터 적용");
    await expect(row).toContainText('"한국어"');
    const eff = await apiCall<{ items: { key: string; effective: unknown }[] }>("GET", "/settings/effective");
    expect(eff.items.find((i) => i.key === "output.language")?.effective).toBe("한국어");
    // 고급 항목은 검색 없이 접혀 있다
    await page.getByLabel("설정 검색").fill("");
    await page.getByRole("button", { name: "서버·데이터" }).click();
    await expect(page.getByTestId("setting-approval.ttl_secs")).toHaveCount(0);
    await page.getByRole("button", { name: /고급 항목 \d+개 펼치기/ }).click();
    await expect(page.getByTestId("setting-approval.ttl_secs")).toBeVisible();
});
