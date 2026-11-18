import { expect, test, type Page } from "@playwright/test";
import { login, selectChoice } from "./helpers";

// UI-030: light/dark/soft 테마와 OS 테마 연동, 본문·보조 글·버튼 글자의 대비(WCAG AA 4.5:1).
type Colors = { bg: string; panel: string; text: string; muted: string; accent: string; onAccent: string; scheme: string; meta: string | null };

async function colors(page: Page): Promise<Colors> {
    return page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const v = (n: string) => {
            // Astryx 정적 테마의 light-dark()/var()를 실제 렌더링 색으로 정규화한다.
            const probe = document.createElement("span");
            probe.style.color = `var(${n})`;
            document.documentElement.appendChild(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            const channels = color.match(/[\d.]+/g)!;
            return "#" + channels.slice(0, 3).map((channel) => Math.round(Number(channel)).toString(16).padStart(2, "0")).join("");
        };
        return {
            bg: v("--bg"),
            panel: v("--panel"),
            text: v("--text"),
            muted: v("--muted"),
            accent: v("--accent"),
            onAccent: v("--on-accent"),
            scheme: cs.colorScheme,
            meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
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
        const button = await page.getByRole("button", { name: "로그인", exact: true }).evaluate((node) => {
            const style = getComputedStyle(node);
            const hex = (color: string) => "#" + color.match(/[\d.]+/g)!.slice(0, 3)
                .map((channel) => Math.round(Number(channel)).toString(16).padStart(2, "0")).join("");
            return { text: hex(style.color), background: hex(style.backgroundColor) };
        });
        expect(contrast(button.text, button.background), `${theme}/${os} 실제 로그인 버튼`).toBeGreaterThanOrEqual(4.5);
        for (const [fg, bg, name] of [[c.text, c.bg, "본문"], [c.text, c.panel, "패널 본문"], [c.muted, c.panel, "보조 글"], [c.muted, c.bg, "보조 글(배경)"], [c.onAccent, c.accent, "버튼 글자"]] as const) {
            expect(contrast(fg, bg), `${theme}/${os} ${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
    }
    // 고정 테마는 OS와 무관
    expect(results["light/dark"]!.bg).toBe("#f7f7f8");
    expect(results["light/dark"]!.scheme).toBe("light");
    expect(results["soft/dark"]!.bg).toBe("#e9ebee");
    expect(results["dark/light"]!.bg).toBe("#14161b");
    expect(results["dark/light"]!.scheme).toBe("dark");
    // system은 OS를 따른다
    expect(results["system/light"]!.bg).toBe("#f7f7f8");
    expect(results["system/dark"]!.bg).toBe("#14161b");
    // 주소창 색
    expect(results["dark/light"]!.meta).toBe("#14161b");
    expect(results["soft/dark"]!.meta).toBe("#e9ebee");
    // system 사용 중 OS가 바뀌면 새로고침 없이 따라간다
    await page.emulateMedia({ colorScheme: "light" });
    await setTheme(page, "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await colors(page)).bg).toBe("#14161b");
    await expect.poll(async () => (await colors(page)).meta).toBe("#14161b");
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});

test("설정 화면에서 테마를 고르면 바로 적용되고 로그인 화면에도 유지된다", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await login(page);
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
    await page.reload();
    await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("테마");
    await selectChoice(page.getByLabel("테마", { exact: true }), "soft");
    await expect.poll(async () => (await colors(page)).bg).toBe("#e9ebee");
    // 로그아웃 상태(로그인 화면)에서도 같은 테마
    await page.context().clearCookies();
    await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) if (k !== "grove.device.prefs") localStorage.removeItem(k);
        for (const k of Object.keys(sessionStorage)) sessionStorage.removeItem(k);
    });
    await page.goto("/");
    await expect(page.getByRole("form", { name: "로그인" })).toBeVisible();
    expect((await colors(page)).bg).toBe("#e9ebee");
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});
