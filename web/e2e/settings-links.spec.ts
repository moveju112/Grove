import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, ensureProjects, expectChoice, login } from "./helpers";

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
    });
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
    await page.getByRole("button", { name: "설정", exact: true }).click();
    return page.getByTestId("settings");
}

async function scrollTop(pane: Locator) {
    await pane.getByTestId("pane-body").evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => pane.getByTestId("pane-body").evaluate((element) => element.scrollTop)).toBe(0);
}

test("effective 응답을 보류해도 실제 고급 행이 렌더된 뒤 이동하고 재조회는 사용자 스크롤을 빼앗지 않는다", async ({ page }) => {
    const gate = await holdEffective(page);
    try {
        await login(page);
        await page.clock.install();
        await setLink(page, advancedKey);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        const settings = page.getByTestId("settings");
        await gate.seen;
        await expect(settings.getByRole("button", { name: "에이전트·워크플로우", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(settings.getByRole("button", { name: /고급 항목 \d+개 펼치기/ })).toHaveCount(0);
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
        // 실제 sleep 없이 느린 조회 중에도 시간이 흐르는 상황을 고정한다.
        await page.clock.runFor(1_000);
        await gate.deliver();
        const row = settings.getByTestId(`setting-${advancedKey}`);
        await expect(row).toBeInViewport();
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
        const original = await row.locator("input[type=number]").inputValue();
        await scrollTop(page.getByTestId("pane"));
        // 격리 E2E 서버의 정상 저장 이벤트로 같은 effective cache를 다시 읽힌다.
        const current = await apiCall<{ items: { key: string; layers: Record<string, { revision: number }> }[] }>("GET", "/settings/effective");
        const item = current.items.find((entry) => entry.key === advancedKey)!;
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === effectivePath);
        await apiCall("PUT", `/settings/server/-/${advancedKey}`, {
            expected_revision: item.layers.server!.revision,
            value: Number(original) + 1,
        });
        await refreshed;
        await expect(row.locator("input[type=number]")).toHaveValue(String(Number(original) + 1));
        await expect.poll(() => page.getByTestId("pane-body").evaluate((element) => element.scrollTop)).toBe(0);
    } finally {
        gate.release();
    }
});

for (const key of [advancedKey, "exec.max_memory_mb"]) {
    test(`같은 항목 ${key}이 있는 두 pane 중 늦게 연 대화 설정만 이동하고 양쪽 대상과 미저장 초안을 보존한다`, async ({ page }) => {
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
        // 분할 생성의 상위 트리 remount와 링크 이동을 분리한다. 초안은 안정된 두 pane에서 만든다.
        await page.getByRole("region", { name: "최근", exact: true }).getByTestId("recent-item").filter({ hasText: rightTitle }).getByRole("button", { name: "최근 항목 관리", exact: true }).click();
        await page.getByRole("dialog", { name: "최근 항목 관리", exact: true }).getByRole("button", { name: "오른쪽에 열기" }).click();
        const left = page.getByTestId("pane").nth(0);
        const right = page.getByTestId("pane").nth(1);
        await left.getByRole("button", { name: "대화 작업", exact: true }).click();
        await left.getByRole("button", { name: "대화 설정" }).click();
        const leftRow = left.getByTestId(`setting-${key}`);
        await expect(leftRow).toBeInViewport();
        const draft = String(Number(await leftRow.locator("input[type=number]").inputValue()) + 7);
        await leftRow.locator("input[type=number]").fill(draft);
        await expect(leftRow).toContainText("저장 안 됨");
        const gate = await holdEffective(page, rightSession.id);
        try {
            await right.getByRole("button", { name: "대화 작업", exact: true }).click();
            await right.getByRole("button", { name: "대화 설정" }).click();
            await gate.seen;
            await expect(right.getByText("링크한 설정을 불러오는 중…", { exact: true })).toBeVisible();
            await scrollTop(left);
            await gate.deliver();
            const rightRow = right.getByTestId(`setting-${key}`);
            await expect(rightRow).toBeInViewport();
            await expect(leftRow.locator("input[type=number]")).toHaveValue(draft);
            await expect(leftRow).toContainText("저장 안 됨");
            // context 여유분은 프로젝트까지, exec 한도는 대화 범위까지 지원한다.
            const sessionScope = key === "exec.max_memory_mb";
            await expect(leftRow).toContainText(sessionScope ? `대상: 대화 “${leftTitle}”` : `대상: 프로젝트 “${a.name}”`);
            await expect(rightRow).toContainText(sessionScope ? `대상: 대화 “${rightTitle}”` : `대상: 프로젝트 “${b.name}”`);
            await expectChoice(leftRow.getByRole("combobox"), sessionScope ? "session" : "project");
            await expect(left.getByTestId("settings-origin")).toContainText(leftTitle);
            await expect(right.getByTestId("settings-origin")).toContainText(rightTitle);
            await expect(left.getByTestId("setting-output.language")).toContainText(`대상: 대화 “${leftTitle}”`);
            await expect(right.getByTestId("setting-output.language")).toContainText(`대상: 대화 “${rightTitle}”`);
            await expect.poll(() => left.getByTestId("pane-body").evaluate((element) => element.scrollTop)).toBe(0);
            // 링크 클릭은 이 Settings 인스턴스에서만 처리한다. 키보드 활성화도 같은 경로다.
            const rightDraft = String(Number(await rightRow.locator("input[type=number]").inputValue()) + 9);
            await rightRow.locator("input[type=number]").fill(rightDraft);
            await rightRow.locator("a").focus();
            await page.keyboard.press("Enter");
            await expect(rightRow).toBeInViewport();
            await expect(rightRow.locator("input[type=number]")).toHaveValue(rightDraft);
            await expect(rightRow).toContainText("저장 안 됨");
            await expect(leftRow.locator("input[type=number]")).toHaveValue(draft);
            await expect.poll(() => left.getByTestId("pane-body").evaluate((element) => element.scrollTop)).toBe(0);
        } finally {
            gate.release();
        }
    });
}

test("실행 설정의 지연된 행도 전용 영역 안에서 직접 링크로 드러난다", async ({ page }) => {
    const gate = await holdEffective(page);
    let releaseOverview!: () => void;
    let overviewRequested!: () => void;
    const overviewHeld = new Promise<void>((resolve) => { releaseOverview = resolve; });
    const overviewSeen = new Promise<void>((resolve) => { overviewRequested = resolve; });
    await page.route("**/api/v1/agent-overview?*", async (route) => {
        const response = await route.fetch();
        overviewRequested();
        await overviewHeld;
        await route.fulfill({ response });
    });
    let releaseDefinitions!: () => void;
    let definitionsRequested!: () => void;
    const definitionsHeld = new Promise<void>((resolve) => { releaseDefinitions = resolve; });
    const definitionsSeen = new Promise<void>((resolve) => { definitionsRequested = resolve; });
    await page.route((url) => url.pathname === "/api/v1/definitions" && url.searchParams.get("kind") === "agent", async (route) => {
        const response = await route.fetch();
        definitionsRequested();
        await definitionsHeld;
        await route.fulfill({ response });
    });
    try {
        const settings = await openSettings(page, "exec.max_memory_mb");
        await gate.seen;
        await definitionsSeen;
        await overviewSeen;
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
        await gate.deliver();
        const row = settings.getByTestId("exec-settings").getByTestId("setting-exec.max_memory_mb");
        await expect(row).toBeVisible();
        // 행만 준비됐어도 앞쪽 내용이 미완성이면 최초 이동을 아직 소비하지 않는다.
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
        const definitionsReceived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/definitions");
        releaseDefinitions();
        await definitionsReceived;
        await expect(settings.getByTestId("setting-definitions").getByRole("button", { name: /^Reviewer/, includeHidden: true })).toBeAttached();
        // 개요도 앞쪽 높이를 바꾸므로 정의 목록만 준비됐다고 이동하면 안 된다.
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
        releaseOverview();
        await expect(settings.getByTestId("agent-overview").getByRole("heading", { name: /등록된 역할/, includeHidden: true })).toBeAttached();
        await expect(row).toBeInViewport();
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
        const current = await apiCall<{ items: { key: string; layers: Record<string, { revision: number }> }[] }>("GET", "/settings/effective");
        const item = current.items.find((entry) => entry.key === "exec.max_memory_mb")!;
        await scrollTop(page.getByTestId("pane"));
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === effectivePath);
        // 0(제한 없음)을 그대로 저장해 격리 서버의 한도는 바꾸지 않고 재조회만 유도한다.
        await apiCall("PUT", "/settings/server/-/exec.max_memory_mb", { expected_revision: item.layers.server!.revision, value: 0 });
        await refreshed;
        await expect(row).toContainText("대상: 서버 전체");
        await expect.poll(() => page.getByTestId("pane-body").evaluate((element) => element.scrollTop)).toBe(0);
    } finally {
        gate.release();
        releaseDefinitions();
        releaseOverview();
    }
});

test("응답 대기 중 검색으로 이동하면 늦은 결과가 검색과 스크롤을 되돌리지 않는다", async ({ page }) => {
    const gate = await holdEffective(page);
    try {
        const settings = await openSettings(page, advancedKey);
        await gate.seen;
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toBeVisible();
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
        await page.getByTestId("pane").getByRole("button", { name: "탭 닫기" }).click();
        await expect(settings).toHaveCount(0);
        await page.evaluate(() => history.replaceState(history.state, "", location.pathname));
        await gate.deliver();
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
        await settings.getByRole("button", { name: "에이전트·워크플로우", exact: true }).click();
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
        await expect(settings.getByRole("alert")).toHaveText("링크한 설정을 불러오지 못했습니다.");
        await expect(settings.getByText("링크한 설정을 불러오는 중…")).toHaveCount(0);
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toHaveCount(0);
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
        await settings.getByRole("button", { name: "에이전트·워크플로우", exact: true }).click();
        await expect(settings.getByRole("button", { name: /고급 항목 \d+개 펼치기/ })).toBeVisible();
        await settings.getByLabel("설정 검색").fill("입력 여유");
        await expect(settings.getByTestId(`setting-${advancedKey}`)).toBeVisible();
        expect(errors).toEqual([]);
    });
}
