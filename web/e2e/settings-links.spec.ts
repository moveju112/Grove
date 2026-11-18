import { expect, test, type Page } from "@playwright/test";
import { apiCall, ensureProjects, expectChoice, login, openTool, settingsGroupHeader } from "./helpers";

const advancedKey = "context.input_reserve_tokens";
const effectivePath = "/api/v1/settings/effective";

// 실제 서버 응답까지 받은 뒤 브라우저에 전달하는 순간만 제어한다.
async function holdEffective(page: Page, sessionId?: string) {
    let requested!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => { requested = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const matches = (url: URL) => url.pathname === effectivePath
        && (sessionId === undefined || url.searchParams.get("session_id") === sessionId);
    await page.route(matches, async (route) => {
        const response = await route.fetch();
        requested();
        await held;
        await route.fulfill({ response });
    }, { times: 1 });
    return {
        seen,
        release,
        async deliver() {
            const received = page.waitForResponse((response) => matches(new URL(response.url())));
            release();
            await received;
        },
    };
}

async function setLink(page: Page, key: string) {
    await page.evaluate((value) => {
        history.replaceState(history.state, "", `#setting-${encodeURIComponent(value)}`);
    }, key);
}

async function openSettings(page: Page, key: string) {
    await login(page);
    await setLink(page, key);
    if (page.viewportSize()!.width <= 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    return page.getByTestId("settings");
}

async function scrollTop(page: Page) {
    await page.getByTestId("settings-scroll").evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => page.getByTestId("settings-scroll").evaluate((element) => element.scrollTop)).toBe(0);
}

for (const width of [1280, 390]) {
    test(`${width}px: 설정 링크 아이콘 없이도 주소로 항목을 바로 연다`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 844 });
        const settings = await openSettings(page, "tools.mode");
        await expect(settings.getByRole("button", { name: "도구·권한", exact: true })).toHaveAttribute("aria-current", "page");
        const row = settings.getByTestId("setting-tools.mode");
        await expect(row).toBeInViewport();
        await expect(row.getByRole("heading", { name: "도구 실행 모드", exact: true })).toBeVisible();
        await expect(row.getByRole("combobox", { name: "도구 실행 모드", exact: true })).toBeVisible();
        await expect(settings.locator('a[href^="#setting-"]')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`settings-without-link-icons-${width}.png`) });
    });
}

test("제목 모델 링크를 열면 자동 생성 설정과 함께 표시한다", async ({ page }) => {
    const settings = await openSettings(page, "session.title_profile");
    const title = settings.getByTestId("setting-basic-definitions").getByTestId("workflow-title-generator");
    await expect(settings.getByRole("button", { name: "워크플로우·메모리", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(title.getByTestId("setting-session.auto_title")).toBeVisible();
    const model = title.getByTestId("setting-session.title_profile");
    await expect(model.getByRole("button", { name: "제목 생성 모델", exact: true })).toBeVisible();
    await expect(model).toBeInViewport();
    await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
});

test("접힌 보조 기능의 모델 링크는 해당 워크플로우 행을 펼친다", async ({ page }) => {
    const settings = await openSettings(page, "agents.profile.handoff-summarizer");
    const row = settings.getByTestId("workflow-handoff-summarizer");
    await expect(row.getByRole("button", { name: "인계 요약 접기", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByTestId("setting-agents.profile.handoff-summarizer")).toBeInViewport();
    await expect(settings.getByTestId("setting-session.title_profile")).toHaveCount(0);
    await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
});

test("effective 응답을 보류해도 실제 고급 행이 렌더된 뒤 이동하고 재조회는 사용자 스크롤을 빼앗지 않는다", async ({ page }) => {
    const gate = await holdEffective(page);
    try {
        await login(page);
        await page.clock.install();
        await setLink(page, advancedKey);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        const settings = page.getByTestId("settings");
        await gate.seen;
        await expect(settings.getByRole("button", { name: "대화·컨텍스트", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(settings.getByRole("button", { name: /고급 항목 \d+개 펼치기/ })).toHaveCount(0);
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
        // 실제 sleep 없이 느린 조회 중에도 시간이 흐르는 상황을 고정한다.
        await page.clock.runFor(1_000);
        await gate.deliver();
        const row = settings.getByTestId(`setting-${advancedKey}`);
        await expect(row).toBeInViewport();
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
        const original = await row.locator("input").filter({ visible: true }).inputValue();
        await scrollTop(page);
        // 격리 E2E 서버의 정상 저장 이벤트로 같은 effective cache를 다시 읽힌다.
        const current = await apiCall<{ items: { key: string; layers: Record<string, { revision: number }> }[] }>("GET", "/settings/effective");
        const item = current.items.find((entry) => entry.key === advancedKey)!;
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === effectivePath);
        await apiCall("PUT", `/settings/server/-/${advancedKey}`, {
            expected_revision: item.layers.server!.revision,
            value: Number(original) + 1,
        });
        await refreshed;
        await expect(row.locator("input").filter({ visible: true })).toHaveValue(String(Number(original) + 1));
        await expect.poll(() => page.getByTestId("settings-scroll").evaluate((element) => element.scrollTop)).toBe(0);
    } finally {
        gate.release();
    }
});

for (const key of [advancedKey, "exec.max_memory_mb"]) {
    test(`같은 항목 ${key}도 대화별 설정 창의 대상과 초안을 섞지 않고 작업 탭을 유지한다`, async ({ page }) => {
        const { a, b } = await ensureProjects();
        const leftTitle = `링크 왼쪽 ${Date.now()}`;
        const rightTitle = `링크 오른쪽 ${Date.now()}`;
        const leftSession = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: leftTitle });
        const rightSession = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: rightTitle });
        for (const [project, session] of [[a, leftSession], [b, rightSession]] as const) {
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        }
        await login(page);
        await setLink(page, key);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(leftTitle) }).first().click();
        // 프로젝트별 작업은 명시적으로 프로젝트를 드래그해 함께 분할한다.
        const recent = page.getByRole("region", { name: "최근", exact: true });
        await recent.getByRole("button", { name: new RegExp(rightTitle) }).first().click();
        await recent.getByRole("button", { name: new RegExp(leftTitle) }).first().click();
        const left = page.locator(`[data-project-pane="${a.id}"]`).getByTestId("pane");
        const bounds = (await left.boundingBox())!;
        await page.getByTestId("project-row").getByRole("button", { name: b.name, exact: true })
            .dragTo(left, { targetPosition: { x: bounds.width - 12, y: bounds.height / 2 } });
        const right = page.locator(`[data-project-pane="${b.id}"]`).getByTestId("pane");
        await expect(left).toBeVisible();
        await expect(right).toBeVisible();
        await left.getByLabel("메시지 입력").fill("왼쪽 작업 초안");
        await right.getByLabel("메시지 입력").fill("오른쪽 작업 초안");
        const workTabs = page.getByRole("tablist", { name: "열린 대화와 화면", exact: true }).getByRole("tab");
        const tabCount = await workTabs.count();
        await openTool(left, "대화");
        await left.getByRole("button", { name: "대화 설정" }).click();
        const leftRow = page.getByTestId("settings").getByTestId(`setting-${key}`);
        await expect(leftRow).toBeInViewport();
        const draft = String(Number(await leftRow.locator("input").filter({ visible: true }).inputValue()) + 7);
        await leftRow.locator("input").filter({ visible: true }).fill(draft);
        await expect(leftRow.locator("input").filter({ visible: true })).toHaveValue(draft);
        await expect(page.getByTestId("settings-origin")).toContainText(leftTitle);
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await expect(left.getByLabel("메시지 입력")).toHaveValue("왼쪽 작업 초안");
        await left.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
        const gate = await holdEffective(page, rightSession.id);
        try {
            await openTool(right, "대화");
            await right.getByRole("button", { name: "대화 설정" }).click();
            await gate.seen;
            const settings = page.getByTestId("settings");
            await expect(settings.getByText("링크한 설정을 불러오는 중…", { exact: true })).toBeVisible();
            await gate.deliver();
            const rightRow = settings.getByTestId(`setting-${key}`);
            await expect(rightRow).toBeInViewport();
            await expect(rightRow.locator("input").filter({ visible: true })).not.toHaveValue(draft);
            // context 여유분은 프로젝트까지, exec 한도는 대화 범위까지 지원한다.
            const sessionScope = key === "exec.max_memory_mb";
            await expect(settingsGroupHeader(rightRow)).toContainText(sessionScope ? `대화 “${rightTitle}”` : `프로젝트 “${b.name}”`);
            await expectChoice(rightRow.getByRole("combobox"), sessionScope ? "session" : "project");
            await expect(settings.getByTestId("settings-origin")).toContainText(rightTitle);
            if (sessionScope) {
                await expect(settings.getByRole("button", { name: "실행·한도", exact: true })).toHaveAttribute("aria-current", "page");
            } else {
                await expect(settingsGroupHeader(settings.getByTestId("setting-output.style"))).toContainText(`대화 “${rightTitle}”`);
            }
            // 직접 링크로 연 창에서도 링크 아이콘 없이 대상과 초안을 유지한다.
            const rightDraft = String(Number(await rightRow.locator("input").filter({ visible: true }).inputValue()) + 9);
            await rightRow.locator("input").filter({ visible: true }).fill(rightDraft);
            await expect(settings.locator('a[href^="#setting-"]')).toHaveCount(0);
            await expect(rightRow).toBeInViewport();
            await expect(rightRow.locator("input").filter({ visible: true })).toHaveValue(rightDraft);
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
            await expect(left.getByLabel("메시지 입력")).toHaveValue("왼쪽 작업 초안");
            await expect(right.getByLabel("메시지 입력")).toHaveValue("오른쪽 작업 초안");
            await expect(workTabs).toHaveCount(tabCount);
        } finally {
            gate.release();
        }
    });
}

test("실행 설정의 지연된 행도 전용 영역 안에서 직접 링크로 드러난다", async ({ page }) => {
    const gate = await holdEffective(page);
    try {
        const settings = await openSettings(page, "exec.max_memory_mb");
        await gate.seen;
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
        const row = settings.getByTestId("exec-settings").getByTestId("setting-exec.max_memory_mb");
        await expect(row).toHaveCount(0);
        await gate.deliver();
        // 명령 실행이 원본 설정보다 앞에 있어, 원본 조회와 무관하게 이동할 수 있다.
        await expect.poll(() => settings.getByRole("region").evaluateAll((regions) =>
            regions.map((region) => region.getAttribute("aria-label")).filter((label) => label === "명령 실행" || label === "원본 Claude/Codex 설정")
        )).toEqual(["명령 실행", "원본 Claude/Codex 설정"]);
        await expect(settings.getByTestId("setting-basic-definitions")).toHaveCount(0);
        await expect(row).toBeInViewport();
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
        const current = await apiCall<{ items: { key: string; layers: Record<string, { revision: number }> }[] }>("GET", "/settings/effective");
        const item = current.items.find((entry) => entry.key === "exec.max_memory_mb")!;
        await scrollTop(page);
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === effectivePath);
        // 0(제한 없음)을 그대로 저장해 격리 서버의 한도는 바꾸지 않고 재조회만 유도한다.
        await apiCall("PUT", "/settings/server/-/exec.max_memory_mb", { expected_revision: item.layers.server!.revision, value: 0 });
        await refreshed;
        await expect(settingsGroupHeader(row)).toContainText("서버 전체");
        await expect.poll(() => page.getByTestId("settings-scroll").evaluate((element) => element.scrollTop)).toBe(0);
    } finally {
        gate.release();
    }
});

test("응답 대기 중 검색으로 이동하면 늦은 결과가 검색과 스크롤을 되돌리지 않는다", async ({ page }) => {
    const gate = await holdEffective(page);
    try {
        const settings = await openSettings(page, advancedKey);
        await gate.seen;
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
        await settings.getByRole("tab", { name: "로컬 설정", exact: true }).click();
        await settings.getByLabel("설정 검색").fill("테마");
        await gate.deliver();
        await expect(settings.getByTestId("setting-theme")).toBeInViewport();
        await expect(settings.getByLabel("설정 검색")).toHaveValue("테마");
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
    } finally {
        gate.release();
    }
});

test("닫은 설정의 늦은 응답은 다시 연 설정의 기본 접힘을 바꾸지 않는다", async ({ page }) => {
    const gate = await holdEffective(page);
    try {
        const settings = await openSettings(page, advancedKey);
        await gate.seen;
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        await expect(settings).toHaveCount(0);
        await page.evaluate(() => history.replaceState(history.state, "", location.pathname));
        await gate.deliver();
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
        await settings.getByRole("tab", { name: "데몬 설정", exact: true }).click();
        await settings.getByRole("button", { name: "대화·컨텍스트", exact: true }).click();
        await expect(settings.getByRole("button", { name: /고급 항목 \d+개 펼치기/ })).toBeVisible();
        await settings.getByLabel("설정 검색").fill("입력 여유");
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toBeVisible();
    } finally {
        gate.release();
    }
});

for (const mode of ["조회 오류", "응답에 항목 없음"] as const) {
    test(`${mode}는 링크 이동 성공으로 숨기지 않고 종료한다`, async ({ page }) => {
        await page.route((url) => url.pathname === effectivePath, async (route) => {
            if (mode === "조회 오류") {
                await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "설정 조회 실패", retryable: false } } });
            } else {
                const response = await route.fetch();
                const body = await response.json() as { items: { key: string }[] };
                await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.key !== advancedKey) } });
            }
        });
        const settings = await openSettings(page, advancedKey);
        await expect(settings.getByRole("alert").filter({ hasText: "링크한 설정을 불러오지 못했습니다." })).toBeVisible();
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
        await settings.getByRole("tab", { name: "로컬 설정", exact: true }).click();
        await settings.getByLabel("설정 검색").fill("테마");
        await expect(settings.getByTestId("setting-theme")).toBeVisible();
    });
}

for (const hash of ["#setting-does.not.exist", "#setting-%E0%A4%A", "#setting-%22%5D%5Bdata-testid%3D%22setting-theme"]) {
    test(`잘못된 링크 ${hash}도 화면과 검색을 망가뜨리지 않는다`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await login(page);
        await page.evaluate((value) => history.replaceState(history.state, "", value), hash);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        const settings = page.getByTestId("settings");
        await settings.getByRole("tab", { name: "데몬 설정", exact: true }).click();
        await settings.getByRole("button", { name: "대화·컨텍스트", exact: true }).click();
        await expect(settings.getByRole("button", { name: /고급 항목 \d+개 펼치기/ })).toBeVisible();
        await settings.getByLabel("설정 검색").fill("입력 여유");
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toBeVisible();
        expect(errors).toEqual([]);
    });
}
