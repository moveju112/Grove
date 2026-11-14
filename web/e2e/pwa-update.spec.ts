import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script } from "./helpers";

// FLOW-16: 새 PWA 버전이 발행돼도 진행 중인 stream과 입력을 끊지 않고, 사용자가 고를 때만 전환한다.
// 서버는 web/build/client를 매번 디스크에서 읽으므로(sw.js는 no-cache) 파일을 바꾸면 새 버전 발행과 같다.
const SW = join(process.cwd(), "build/client/sw.js");

test("새 버전 발행 중에도 stream과 초안이 유지되고, 사용자가 고를 때만 새 버전으로 바뀐다", async ({ page }) => {
    const original = readFileSync(SW, "utf8");
    try {
        const { b } = await ensureProjects();
        await ensureProfile();
        const s = await apiCall<{ id: string }>("POST", `/projects/${b.id}/sessions`, { title: "PWA 업데이트 대화" });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: b.id, resource_id: s.id });
        await login(page);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
        const oldScript = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
        await page.locator(".recent").getByRole("button", { name: /PWA 업데이트 대화/ }).first().click();
        const view = page.getByTestId("session-view");
        await expect(view).toHaveAttribute("data-session", s.id);

        // 1) 느린 응답 stream 시작, 그 사이에 다음 입력을 쓴다
        await script({ frames: frames.text(["업데이트 ", "중에도 ", "끊기지 ", "않는 ", "답변"]), delayMs: 500 });
        await composerOption(view, "보내기 방식", "model");
        await view.getByLabel("메시지 입력").fill("첫 질문");
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("partial")).toBeVisible();
        await view.getByLabel("메시지 입력").fill("업데이트 중에 쓰는 글");

        // 2) 새 버전 발행 → 확인(update)만 하고 적용하지 않는다
        writeFileSync(SW, original.replace(/const VERSION = "([^"]+)"/, 'const VERSION = "$1-next"'));
        await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            await reg!.update();
        });
        const banner = page.getByRole("status").filter({ hasText: "새 버전이 준비되었습니다" });
        await expect(banner).toBeVisible({ timeout: 15_000 });

        // 3) 강제 reload 없음: stream은 끝까지 오고 입력은 그대로, 아직 예전 worker가 제어한다
        await expect(view.getByTestId("msg-assistant").last()).toContainText("업데이트 중에도 끊기지 않는 답변", { timeout: 15_000 });
        await expect(view.getByLabel("메시지 입력")).toHaveValue("업데이트 중에 쓰는 글");
        const marker = await page.evaluate(() => ((window as unknown as { __marker?: number }).__marker = 1));
        expect(marker).toBe(1);

        // 4) 사용자가 고르면 전환: 한 번 다시 불러오고, 초안·대화·연결이 복원된다
        await page.waitForTimeout(1200); // 초안 저장(debounce)
        await banner.getByRole("button", { name: "업데이트", exact: true }).click();
        await page.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined, undefined, { timeout: 15_000 });
        await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        const v2 = page.getByTestId("session-view");
        await expect(v2).toHaveAttribute("data-session", s.id);
        await expect(v2.getByLabel("메시지 입력")).toHaveValue("업데이트 중에 쓰는 글");
        await expect(v2.getByTestId("msg-assistant")).toHaveCount(1);
        await expect(v2.getByTestId("msg-assistant").last()).toContainText("업데이트 중에도 끊기지 않는 답변");
        // 새 worker가 제어하고, 같은 턴이 다시 실행되지 않았다
        const active = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return { waiting: reg!.waiting !== null, controller: navigator.serviceWorker.controller?.scriptURL };
        });
        expect(active.waiting).toBe(false);
        expect(active.controller).toBe(oldScript); // 같은 URL(/sw.js), 내용만 새 버전
        // 자산 cache와 대화 데이터 분리: cache에는 API 응답이 없고, 활성화 뒤 이전 버전 cache는 지워진다(WEB-008, 014)
        const caches_ = await page.evaluate(async () => {
            const names = await caches.keys();
            const urls: string[] = [];
            for (const n of names) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
            return { names, urls };
        });
        expect(caches_.names.filter((n) => n.startsWith("grove-shell-"))).toHaveLength(1);
        expect(caches_.names[0]).toMatch(/-next$/);
        expect(caches_.urls.some((u) => u.startsWith("/api/"))).toBe(false);
        expect(caches_.urls.length).toBeGreaterThan(0);
        const turns = await apiCall<{ id: string }[] | { items: { id: string }[] }>("GET", `/sessions/${s.id}/turns`);
        expect(Array.isArray(turns) ? turns.length : turns.items.length).toBe(1);
    } finally {
        writeFileSync(SW, original);
    }
});
