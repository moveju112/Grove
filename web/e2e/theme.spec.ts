import { expect, test, type Page } from "@playwright/test";
import { login, selectChoice } from "./helpers";

const registerButton = (page: Page) => page.getByRole("button", { name: "페어링 링크·QR로 등록", exact: true });

// UI-030: 고정 테마와 OS 테마 연동, 본문·보조 글·버튼 글자의 대비(WCAG AA 4.5:1).
async function colors(page: Page) {
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
            hover: v("--hover"),
            selected: v("--sel"),
            text: v("--text"),
            muted: v("--muted"),
            accent: v("--accent"),
            onAccent: v("--on-accent"),
            codeBackground: v("--color-syntax-background"),
            codeText: ["keyword", "string", "comment", "number", "function", "type", "variable",
                "operator", "constant", "tag", "attribute", "property", "punctuation"].map((name) => v(`--color-syntax-${name}`)),
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
    await page.locator("html[data-hydrated=true]").waitFor({ state: "attached" });
}

test("테마별 대비가 AA 이상이고 system은 OS를, 고정 테마는 OS와 무관하게 따른다", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const cases = [
        { theme: "light", os: "dark", background: "#f7f7f8", scheme: "light" },
        { theme: "dark", os: "light", background: "#14161b", scheme: "dark" },
        { theme: "soft", os: "dark", background: "#e9ebee", scheme: "light" },
        { theme: "light-gray", os: "dark", background: "#d4d4d4", scheme: "light", panel: "#e0e0e0", text: "#3b3b3b", code: "#dbdbdb" },
        { theme: "charcoal", os: "light", background: "#242830", scheme: "dark", panel: "#2d323b", text: "#e1e5eb", code: "#242932" },
        { theme: "system", os: "light", background: "#f7f7f8", scheme: "light dark" },
        { theme: "system", os: "dark", background: "#14161b", scheme: "light dark" },
    ] as const;
    for (const { theme, os, background, scheme, ...palette } of cases) {
        await page.emulateMedia({ colorScheme: os });
        await setTheme(page, theme);
        const c = await colors(page);
        expect(c, `${theme}/${os}`).toMatchObject({ bg: background, scheme, meta: background });
        const button = await registerButton(page).evaluate((node) => {
            const style = getComputedStyle(node);
            const hex = (color: string) => "#" + color.match(/[\d.]+/g)!.slice(0, 3)
                .map((channel) => Math.round(Number(channel)).toString(16).padStart(2, "0")).join("");
            return { text: hex(style.color), background: hex(style.backgroundColor) };
        });
        expect(contrast(button.text, button.background), `${theme}/${os} 실제 등록 버튼`).toBeGreaterThanOrEqual(4.5);
        for (const [fg, bg, name] of [[c.text, c.bg, "본문"], [c.text, c.panel, "패널 본문"], [c.muted, c.panel, "보조 글"], [c.muted, c.bg, "보조 글(배경)"], [c.onAccent, c.accent, "버튼 글자"]] as const) {
            expect(contrast(fg, bg), `${theme}/${os} ${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
        if ("panel" in palette) {
            expect(c.panel).toBe(palette.panel);
            expect(c.text).toBe(palette.text);
            expect(c.codeBackground).toBe(palette.code);
            for (const surface of [c.hover, c.selected]) {
                for (const text of [c.text, c.muted]) {
                    expect(contrast(text, surface), `${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
                }
            }
            for (const text of c.codeText) {
                expect(contrast(text, c.codeBackground), `${theme} 코드 ${text} on ${c.codeBackground}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    }
    // system 사용 중 OS가 바뀌면 새로고침 없이 따라간다
    await page.emulateMedia({ colorScheme: "light" });
    await setTheme(page, "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await colors(page)).bg).toBe("#14161b");
    await expect.poll(async () => (await colors(page)).meta).toBe("#14161b");
    await page.evaluate(() => localStorage.removeItem("grove.device.prefs"));
});

for (const [theme, label, background] of [
    ["soft", "부드럽게", "#e9ebee"], ["light-gray", "밝은 회색", "#d4d4d4"], ["charcoal", "차콜", "#242830"],
] as const) {
    test(`설정의 ${label} 선택이 즉시 적용되고 로그인 화면에도 유지된다`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: "light" });
        await login(page);
        await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색").fill(label);
        const choice = page.getByRole("combobox", { name: "테마", exact: true });
        await selectChoice(choice, theme);
        await expect(choice).toContainText(label);
        await expect.poll(async () => (await colors(page)).bg).toBe(background);
        // 로그아웃 상태(로그인 화면)에서도 같은 테마
        await page.context().clearCookies();
        await page.evaluate(() => {
            for (const k of Object.keys(localStorage)) if (k !== "grove.device.prefs") localStorage.removeItem(k);
            for (const k of Object.keys(sessionStorage)) sessionStorage.removeItem(k);
        });
        await page.goto("/");
        await expect(registerButton(page)).toBeVisible();
        expect((await colors(page)).bg).toBe(background);
    });
}
