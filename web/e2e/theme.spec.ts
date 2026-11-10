import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// UI-030: light/dark/soft 테마와 OS 테마 연동, 본문·보조 글·버튼 글자의 대비(WCAG AA 4.5:1).
type Colors = { bg: string; panel: string; text: string; muted: string; accent: string; onAccent: string; scheme: string; meta: string | null; button: string };

async function colors(page: Page): Promise<Colors> {
    return page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const v = (n: string) => cs.getPropertyValue(n).trim();
        const b = document.createElement("button");
        document.body.appendChild(b);
        const button = getComputedStyle(b).color;
        b.remove();
        return {
            bg: v("--bg"),
            panel: v("--panel"),
            text: v("--text"),
            muted: v("--muted"),
            accent: v("--accent"),
            onAccent: v("--on-accent"),
            scheme: cs.colorScheme,
            meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
            button,
        };
    });
}

function lum(hex: string): number {
    const h = hex.replace("#", "");
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
};

async function setTheme(page: Page, theme: string) {
    await page.evaluate((t) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme: t })), theme);
    await page.reload();
}

test("테마별 대비가 AA 이상이고 system은 OS를, 고정 테마는 OS와 무관하게 따른다", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const results: Record<string, Colors> = {};
    for (const [theme, os] of [["light", "dark"], ["dark", "light"], ["soft", "dark"], ["system", "light"], ["system", "dark"]] as const) {
        await page.emulateMedia({ colorScheme: os });
        await setTheme(page, theme);
        const c = await colors(page);
        results[`${theme}/${os}`] = c;
        for (const [fg, bg, name] of [[c.text, c.bg, "본문"], [c.text, c.panel, "패널 본문"], [c.muted, c.panel, "보조 글"], [c.muted, c.bg, "보조 글(배경)"], [c.onAccent, c.accent, "버튼 글자"]] as const) {
            expect(contrast(fg, bg), `${theme}/${os} ${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
    }
    // 고정 테마는 OS와 무관
    expect(results["light/dark"]!.bg).toBe("#f7f8f6");
    expect(results["light/dark"]!.scheme).toBe("light");
    expect(results["soft/dark"]!.bg).toBe("#f1ece2");
    expect(results["dark/light"]!.bg).toBe("#121513");
    expect(results["dark/light"]!.scheme).toBe("dark");
    // system은 OS를 따른다
    expect(results["system/light"]!.bg).toBe("#f7f8f6");
    expect(results["system/dark"]!.bg).toBe("#121513");
    // 주소창 색
    expect(results["dark/light"]!.meta).toBe("#121513");
    expect(results["soft/dark"]!.meta).toBe("#4d6b50");
    // 버튼은 테마의 버튼 글자색을 쓴다(다크 테마에서 흰 글자 대비 부족 회귀 방지)
    expect(results["dark/light"]!.button).toBe("rgb(13, 26, 17)");

    // system 사용 중 OS가 바뀌면 새로고침 없이 따라간다
    await page.emulateMedia({ colorScheme: "light" });
    await setTheme(page, "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await colors(page)).bg).toBe("#121513");
    await expect.poll(async () => (await colors(page)).meta).toBe("#121513");
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});

test("설정 화면에서 테마를 고르면 바로 적용되고 로그인 화면에도 유지된다", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await login(page);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
    await page.reload();
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("테마");
    await page.getByLabel("테마", { exact: true }).selectOption("soft");
    await expect.poll(async () => (await colors(page)).bg).toBe("#f1ece2");
    // 로그아웃 상태(로그인 화면)에서도 같은 테마
    await page.context().clearCookies();
    await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) if (k !== "grove.device.prefs") localStorage.removeItem(k);
        for (const k of Object.keys(sessionStorage)) sessionStorage.removeItem(k);
    });
    await page.goto("/");
    await expect(page.getByRole("form", { name: "로그인" })).toBeVisible();
    expect((await colors(page)).bg).toBe("#f1ece2");
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});
