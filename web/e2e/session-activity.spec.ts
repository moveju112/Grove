import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, expectChoice, login, openSettings, script, selectChoice, sessionView, splitNewConversation } from "./helpers";

test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath("failure.png") });
});

async function openSession(page: Page, title: string) {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
    if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = sessionView(page, session.id);
    const pane = view.locator("xpath=ancestor::*[@data-testid='pane'][1]");
    return { project: a, profile, session, view, pane, indicator: pane.getByTestId("session-activity") };
}

for (const width of [390, 1400]) {
    test.describe(`${width}px 대기 중 새싹`, () => {
        test.use({ viewport: { width, height: 844 } });

        test("대기 중 벽을 따라 움직이며 설정·새로고침·움직임 줄이기·취소를 반영한다", async ({ page }, info) => {
            const { profile, session, view, pane, indicator } = await openSession(page, `새싹 설정 ${width}`);
            await expect(indicator).toHaveCount(0);
            // 실행 장식이 없어도 오른쪽에 전용 빈 열을 남기지 않는다.
            const contentBounds = async () => view.evaluate((node) => {
                const body = node.closest('[data-testid="pane-body"]')!;
                const edge = body.getBoundingClientRect();
                const right = edge.left + body.clientLeft + body.clientWidth;
                const left = edge.left + body.clientLeft;
                return [node.querySelector('[data-testid="composer"]')!, node.querySelector('[data-session-msgs]')!].map((item) => {
                    const box = item.getBoundingClientRect();
                    return { left: box.left - left, right: right - box.right, width: box.width };
                });
            });
            const idleBounds = await contentBounds();
            for (const box of idleBounds) expect(Math.abs(box.left - box.right)).toBeLessThanOrEqual(1);
            await page.screenshot({ path: info.outputPath("session-idle.png") });
            await view.getByLabel("메시지 입력", { exact: true }).click();
            await expect(view.getByLabel("메시지 입력", { exact: true })).toBeFocused();
            await view.getByLabel("메시지 입력", { exact: true }).fill("보존할 입력");
            await expect(view.getByLabel("메시지 입력", { exact: true })).toHaveValue("보존할 입력");
            const question = `vine-hang-${width}`;
            await script({ frames: frames.text(["검사 중이에요."]).slice(0, 1), hang: true, marker: question });
            const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
            try {
                await expect(indicator).toBeVisible();
                expect(await contentBounds()).toEqual(idleBounds);
                await expect(indicator.locator("[data-vine-leaf]")).toHaveCount(24);
                await expect(indicator).toHaveCSS("pointer-events", "none");
                const stem = indicator.locator("[data-vine-stem]");
                await expect(stem).toHaveCSS("stroke-width", width <= 760 ? "0.5px" : "1px");
                await expect(stem).toHaveCSS("opacity", width <= 760 ? "0.14" : "0.55");
                await expect(stem).toHaveCSS("stroke-dasharray", "none");
                expect(await stem.evaluate((node) => node.getAnimations().length)).toBe(0);
                const stemBounds = await stem.boundingBox();
                const outlineBounds = await indicator.boundingBox();
                const stemGeometry = await stem.evaluate((node) => {
                    const box = (node as SVGGraphicsElement).getBBox();
                    return { width: box.width, height: box.height };
                });
                expect(stemGeometry.width).toBeCloseTo(outlineBounds!.width - 6, 0);
                expect(stemGeometry.height).toBeCloseTo(outlineBounds!.height - 6, 0);
                const entrance = await indicator.evaluate(async (node) => {
                    const animation = node.getAnimations().find((item) => item.effect?.getTiming().duration === 600)!;
                    const time = animation.currentTime;
                    animation.pause();
                    const opacity = [];
                    for (const progress of [0, .5, 1]) {
                        animation.currentTime = progress * 600;
                        await new Promise(requestAnimationFrame);
                        opacity.push(Number(getComputedStyle(node).opacity));
                    }
                    animation.currentTime = time;
                    animation.play();
                    return opacity;
                });
                expect(entrance[0]).toBe(0);
                expect(entrance[1]).toBeGreaterThan(0);
                expect(entrance[1]).toBeLessThan(1);
                expect(entrance[2]).toBe(1);
                const runner = indicator.getByTestId("session-vine-runner").first();
                const head = runner.locator("[data-vine-head]");
                // 잎은 접선 안쪽에만 달리고 크기·윤곽은 PC에서만 커진다.
                const leaves = await indicator.locator("[data-vine-leaf]").evaluateAll((nodes) => nodes.map((node) => {
                    const box = (node as SVGGraphicsElement).getBBox();
                    const { transform, strokeWidth } = getComputedStyle(node);
                    const scale = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).d;
                    return { inward: box.y >= 0, height: box.height * scale, strokeWidth };
                }));
                for (const leaf of leaves) {
                    expect(leaf.inward).toBe(true);
                    expect(leaf.height).toBeCloseTo(width === 390 ? 4 : 4.8);
                    expect(leaf.strokeWidth).toBe(width === 390 ? "0.3px" : "0.4px");
                }
                const position = await head.boundingBox();
                await expect.poll(() => head.boundingBox()).not.toEqual(position);
                // 한 바퀴 동안 실제 새싹이 네 변을 모두 방문하고 시작점으로 돌아오는지 확인한다.
                const visits = await head.evaluate(async (node) => {
                    const animation = node.getAnimations()[0]!;
                    const { duration, delay } = animation.effect!.getTiming();
                    const time = animation.currentTime;
                    const overlay = node.closest('[data-testid="session-activity"]')!;
                    const animations = overlay.getAnimations({ subtree: true });
                    animations.forEach((item) => item.pause());
                    const bounds = overlay.getBoundingClientRect();
                    const positions = [];
                    const edges = new Set<number>();
                    for (let step = 0; step <= 16; step++) {
                        animation.currentTime = Number(duration) * step / 16 + Number(delay);
                        await new Promise(requestAnimationFrame);
                        const rect = node.getBoundingClientRect();
                        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
                        positions.push({ x, y });
                        const distances = [Math.abs(y - bounds.top), Math.abs(x - bounds.right),
                            Math.abs(y - bounds.bottom), Math.abs(x - bounds.left)];
                        const closest = Math.min(...distances);
                        if (closest <= 24) edges.add(distances.indexOf(closest));
                    }
                    animation.currentTime = time;
                    animations.forEach((item) => item.play());
                    return { edges: [...edges].sort(), start: positions[0]!, end: positions.at(-1)! };
                });
                expect(visits.edges).toEqual([0, 1, 2, 3]);
                expect(Math.hypot(visits.start.x - visits.end.x, visits.start.y - visits.end.y)).toBeLessThan(1);
                expect(await stem.boundingBox()).toEqual(stemBounds);
                // 입력창 조작과 viewport 고정 테두리는 대화 스크롤의 영향을 받지 않는다.
                await expect(view.getByLabel("메시지 입력", { exact: true })).toHaveValue("보존할 입력");
                const bounds = await indicator.boundingBox();
                const body = pane.getByTestId("pane-body");
                const bodyBounds = await body.boundingBox();
                expect(bounds!.y).toBeCloseTo(bodyBounds!.y, 0);
                expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(bodyBounds!.y + bodyBounds!.height);
                expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(bodyBounds!.x + bodyBounds!.width);
                const composerBounds = await view.getByTestId("composer").boundingBox();
                expect(composerBounds!.x + composerBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 8);
                if (width === 1400) {
                    const tabs = await pane.getByRole("tablist", { name: "열린 대화와 화면" }).boundingBox();
                    expect(bounds!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height);
                }
                await page.screenshot({ path: info.outputPath("session-vines.png") });

                await openSettings(page, "local");
                await page.getByLabel("설정 검색").fill("새싹");
                const display = page.getByRole("combobox", { name: "진행 중 표시", exact: true });
                const groups = page.getByRole("combobox", { name: "잎 무리 수", exact: true });
                const length = page.getByRole("combobox", { name: "잎 무리 길이", exact: true });
                const speed = page.getByRole("combobox", { name: "잎 회전 속도", exact: true });
                const ring = pane.getByTestId("tab-running");
                if (width >= 760) await expect(ring).toHaveCSS("animation-iteration-count", "infinite");
                await selectChoice(display, "static");
                await expect(indicator.getByTestId("session-activity-static")).toBeVisible();
                await expect(head).toHaveCount(0);
                expect(await indicator.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
                await expect(groups).toBeDisabled();
                if (width >= 760) {
                    await expect(ring).toBeAttached();
                    await expect(ring).toHaveCSS("animation-name", "none");
                    await expect(ring.locator("circle")).toHaveCount(1);
                }
                await selectChoice(display, "hidden");
                await expect(indicator).toHaveCount(0);
                await expect(ring).toHaveCount(0);
                expect(await contentBounds()).toEqual(idleBounds);
                await expect(length).toBeDisabled();
                await expect(speed).toBeDisabled();
                await expect(groups).toBeDisabled();
                await selectChoice(display, "animated");
                await selectChoice(length, "long");
                await selectChoice(speed, "fast");
                await expect(indicator.locator("[data-vine-leaf]")).toHaveCount(36);
                for (const count of [3, 4, 7]) {
                    await selectChoice(groups, String(count));
                    await expect(indicator.getByTestId("session-vine-runner")).toHaveCount(count);
                    await expect(indicator.locator("[data-vine-leaf]")).toHaveCount(count * 18);
                }
                const timings = await indicator.locator("[data-vine-head]").evaluateAll((nodes) =>
                    nodes.map((node) => node.getAnimations()[0]!.effect!.getTiming()));
                for (let index = 0; index < timings.length; index++) {
                    const { delay, duration } = timings[index]!;
                    const next = timings[(index + 1) % timings.length]!.delay!;
                    expect(duration).toBe(14_000);
                    expect((delay! - next + 14_000) % 14_000).toBeCloseTo(14_000 / 7);
                }
                await page.screenshot({ path: info.outputPath("vine-settings.png"), animations: "disabled" });
                await page.reload();
                await openSettings(page, "local");
                await page.getByLabel("설정 검색").fill("새싹");
                await expectChoice(display, "animated");
                await expectChoice(groups, "7");
                await expectChoice(length, "long");
                await expectChoice(speed, "fast");
                await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
                await expect(indicator).toBeVisible();
                await expect(indicator.locator("[data-vine-leaf]")).toHaveCount(126);

                await page.emulateMedia({ reducedMotion: "reduce" });
                await expect(head).toBeHidden();
                await expect(indicator.getByTestId("session-activity-static")).toBeVisible();
                await expect(indicator.locator("[data-static-vine-corner]")).toHaveCount(4);
                await expect(stem).toBeHidden();
                expect(await indicator.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
                expect(await contentBounds()).toEqual(idleBounds);
                await page.screenshot({ path: info.outputPath("vine-reduced-motion.png"), animations: "disabled" });
                await page.emulateMedia({ reducedMotion: "no-preference" });
                await expect(head).toBeVisible();
                await expect(indicator.getByTestId("session-activity-static")).toBeHidden();
            } finally {
                await apiCall("POST", `/turns/${turn.turn.id}/cancel`);
            }
            await expect(indicator).toHaveCount(0);
            expect(await contentBounds()).toEqual(idleBounds);
        });

        test("응답이 완료되면 줄기와 잎을 함께 서서히 흐리게 한 뒤 없앤다", async ({ page }) => {
            const { profile, session, indicator } = await openSession(page, `새싹 완료 ${width}`);
            const question = `vine-finish-${width}`;
            await script({ frames: frames.text(["완료 답변"]), delayMs: 500, marker: question });
            const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
            await expect(indicator).toBeVisible();
            await expect(indicator).toHaveCSS("opacity", "1");
            await expect(indicator).toHaveAttribute("data-state", "leaving");
            const fade = await indicator.evaluate(async (node) => {
                const animation = node.getAnimations()[0]!;
                const time = animation.currentTime;
                animation.pause();
                const opacity = [];
                for (const progress of [0, .5, .95]) {
                    animation.currentTime = progress * 600;
                    await new Promise(requestAnimationFrame);
                    opacity.push(Number(getComputedStyle(node).opacity));
                }
                animation.currentTime = time;
                animation.play();
                return opacity;
            });
            expect(fade[0]).toBe(1);
            expect(fade[1]).toBeGreaterThan(0);
            expect(fade[1]).toBeLessThan(1);
            expect(fade[2]).toBeLessThan(fade[1]!);
            await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.turn.id}`)).status).toBe("completed");
            if (width === 1400) {
                // 퇴장 도중 재시작해도 같은 요소를 현재 농도에서 다시 나타내고 이전 퇴장이 제거하지 않는다.
                const element = await indicator.elementHandle();
                await indicator.evaluate(async (node) => {
                    const animation = node.getAnimations()[0]!;
                    animation.pause();
                    animation.currentTime = 300;
                    await new Promise(requestAnimationFrame);
                });
                const nextQuestion = "vine-restart";
                await script({ frames: frames.text(["다음 작업 중이에요."]).slice(0, 1), hang: true, marker: nextQuestion });
                const next = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`,
                    { text: nextQuestion, profile_id: profile });
                try {
                    await expect(indicator).toHaveAttribute("data-state", "active");
                    const from = await indicator.evaluate((node) => Number((node.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!.opacity));
                    expect(from).toBeGreaterThan(0);
                    expect(from).toBeLessThan(1);
                    await expect(indicator).toHaveCSS("opacity", "1");
                    expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
                } finally {
                    await apiCall("POST", `/turns/${next.turn.id}/cancel`);
                }
                await element!.dispose();
            }
            await expect(indicator).toHaveCount(0);
        });

        if (width === 1400) test("탭·스크롤바를 침범하지 않고 분할한 세션별 실행 상태에 맞춰 표시한다", async ({ page }, info) => {
            const { project, profile, session, pane, indicator } = await openSession(page, "새싹 분할");
            const question = "vine-split";
            await script({ frames: frames.text(["처리 중인 내용이에요.\n\n".repeat(30)]).slice(0, 1), hang: true, marker: question });
            const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
            try {
                await expect(indicator).toBeVisible();
                const bounds = await indicator.boundingBox();
                const body = pane.getByTestId("pane-body");
                const head = indicator.locator("[data-vine-head]").first();
                await expect(head).toBeVisible();
                const startTime = await head.evaluate((node) => Number(node.getAnimations()[0]!.startTime));
                await expect.poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
                await body.evaluate((node) => { node.scrollTop = 0; });
                expect(await indicator.boundingBox()).toEqual(bounds);
                // 두꺼운 native 스크롤바가 양쪽 축에 생겨도 그 안쪽에서만 순환한다.
                await page.addStyleTag({ content: '[data-testid="pane-body"]::-webkit-scrollbar { width: 28px; height: 22px; }' });
                const previousWidth = await body.evaluate((node) => {
                    const view = node.firstElementChild as HTMLElement;
                    const previous = view.style.minWidth;
                    node.style.scrollbarGutter = "stable";
                    node.style.overflow = "scroll";
                    view.style.minWidth = `${node.clientWidth + 100}px`;
                    return previous;
                });
                await expect.poll(() => body.evaluate((node) => (node as HTMLElement).offsetWidth - node.clientWidth)).toBeGreaterThan(0);
                await expect.poll(() => body.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeGreaterThan(0);
                await expect.poll(async () => {
                    const client = await body.evaluate((node) => {
                        const box = node.getBoundingClientRect();
                        return { right: box.x + node.clientLeft + node.clientWidth,
                            bottom: box.y + node.clientTop + node.clientHeight - ((node as HTMLElement).offsetHeight > node.clientHeight ? 4 : 16) };
                    });
                    const frame = (await indicator.boundingBox())!;
                    return frame.x + frame.width <= client.right - 4 && frame.y + frame.height <= client.bottom;
                }).toBe(true);
                expect(await head.evaluate((node) => Number(node.getAnimations()[0]!.startTime))).toBeCloseTo(startTime, 3);
                await page.screenshot({ path: info.outputPath("native-scrollbar-clearance.png") });
                await body.evaluate((node, previous) => {
                    (node.firstElementChild as HTMLElement).style.minWidth = previous;
                    node.style.scrollbarGutter = "";
                    node.style.overflow = "";
                }, previousWidth);
                await splitNewConversation(pane, "right");
                await expect(page.getByTestId("project-view").filter({ visible: true })).toBeVisible();
                await expect(page.getByTestId("session-activity").filter({ visible: true })).toHaveCount(1);
                const idle = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "새싹 쉬는 대화" });
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: idle.id });
                const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
                if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: /새싹 쉬는 대화/ }).first().click();
                const idlePane = sessionView(page, idle.id).locator("xpath=ancestor::*[@data-testid='pane'][1]");
                await expect(idlePane.getByTestId("session-activity")).toHaveCount(0);
                await expect(page.getByTestId("session-activity").filter({ visible: true })).toHaveCount(1);
                const staticFrame = (owner: typeof pane) => owner.getByTestId("session-activity-static");
                const runners = (owner: typeof pane) => owner.getByTestId("session-vine-runner");
                await expect(staticFrame(pane)).toBeVisible();
                await expect(runners(pane)).toHaveCount(0);

                const otherMarker = "second-sprout-running";
                await script({ marker: otherMarker, frames: frames.text([otherMarker]).slice(0, 1), hang: true });
                const other = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${idle.id}/turns`, { text: otherMarker, profile_id: profile });
                try {
                    await expect(idlePane.locator("[data-vine-head]").first()).toBeVisible();
                    await pane.getByRole("tab", { selected: true }).getByTestId("tab-title").click();
                    await expect(pane).toHaveAttribute("data-focused", "true");
                    await expect(head).toBeVisible();
                    await expect(runners(idlePane)).toHaveCount(0);
                    await expect(staticFrame(idlePane)).toBeVisible();
                    await expect(staticFrame(pane)).toHaveCount(0);
                } finally {
                    await apiCall("POST", `/turns/${other.turn.id}/cancel`);
                }
            } finally {
                await apiCall("POST", `/turns/${turn.turn.id}/cancel`);
            }
        });
    });
}

test.describe("390px 안쪽 잎 시안", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test("작은 잎이 안쪽으로만 벽을 타는 실제 대화를 캡처한다", async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
        const { profile, session, indicator, view, pane } = await openSession(page, "작은 잎 애니메이션");
        const question = "화면 가장자리를 따라 작은 잎이 안쪽으로만 돌게 해줘.";
        await script({ marker: question, hang: true, frames: frames.text([
            "잎을 약 4px로 줄이고, 줄기 안쪽에만 달았어.\n\n화면 가장자리를 따라 조용히 돌면서 응답이 진행 중임을 보여줘.\n\n| 항목 | 적용한 모양 |\n|---|---|\n| 잎 방향 | 안쪽 한 방향 |\n| 잎 크기 | 약 4px |\n| 이동 경로 | 화면 네 변을 따라 순환 |\n| 여백 | 본문과 입력창의 좌우 동일 |\n\n모서리에서도 방향을 자연스럽게 바꾸며 이동해."
        ]).slice(0, 1) });
        const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: question, profile_id: profile });
        try {
            await expect(view.getByText("모서리에서도 방향을 자연스럽게 바꾸며 이동해.", { exact: true })).toBeVisible();
            await expect(indicator).toHaveCSS("opacity", "1");
            const head = indicator.locator("[data-vine-head]").first();
            const position = await head.boundingBox();
            await expect.poll(() => head.boundingBox()).not.toEqual(position);
            // 고정된 재생 위치로 두 테마의 실제 렌더링을 비교한다. 이동 검사는 위에서 별도로 확인한다.
            await indicator.evaluate((node) => node.getAnimations({ subtree: true }).forEach((animation) => {
                if (animation.effect?.getTiming().iterations === Infinity) {
                    animation.pause();
                    animation.currentTime = 0;
                }
            }));
            for (const theme of ["dark", "light"] as const) {
                await page.emulateMedia({ colorScheme: theme });
                await expect(pane).toHaveCSS("background-color", theme === "dark" ? "rgb(23, 26, 32)" : "rgb(255, 255, 255)");
                await page.screenshot({ path: info.outputPath(`leaf-preview-${theme}-390.png`) });
            }
            await page.emulateMedia({ reducedMotion: "reduce" });
            await page.reload();
            const staticFrame = indicator.getByTestId("session-activity-static");
            await expect(staticFrame).toBeVisible();
            await expect(indicator.getByTestId("session-vine-runner")).toHaveCount(0);
            expect(await indicator.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
            // 네 모서리에서만 안쪽 24px 이내에 잎을 두고 본문 공간을 차지하지 않는다.
            const cornerBounds = await staticFrame.locator("[data-static-vine-corner]").evaluateAll((nodes) => nodes.map((node) => {
                const frame = (node as SVGElement).ownerSVGElement!.getBoundingClientRect();
                const box = node.getBoundingClientRect();
                return { width: box.width, height: box.height,
                    x: Math.min(box.left - frame.left, frame.right - box.right),
                    y: Math.min(box.top - frame.top, frame.bottom - box.bottom) };
            }));
            expect(cornerBounds).toHaveLength(4);
            for (const box of cornerBounds) {
                expect(box.width).toBeLessThan(24);
                expect(box.height).toBeLessThan(24);
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x).toBeLessThan(8);
                expect(box.y).toBeGreaterThanOrEqual(0);
                expect(box.y).toBeLessThan(8);
            }
            for (const theme of ["dark", "light"] as const) {
                await page.emulateMedia({ colorScheme: theme });
                await expect(pane).toHaveCSS("background-color", theme === "dark" ? "rgb(23, 26, 32)" : "rgb(255, 255, 255)");
                await page.screenshot({ path: info.outputPath(`leaf-static-corners-${theme}-390.png`) });
            }
            await openSettings(page, "local");
            await page.getByLabel("설정 검색").fill("새싹");
            const display = page.getByRole("combobox", { name: "진행 중 표시", exact: true });
            await selectChoice(display, "hidden");
            await expect(indicator).toHaveCount(0);
            await selectChoice(display, "animated");
            await expect(staticFrame).toBeVisible();
            await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
        } finally {
            await apiCall("POST", `/turns/${turn.turn.id}/cancel`);
        }
        await expect(indicator).toHaveCount(0);
    });
});
