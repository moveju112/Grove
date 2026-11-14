import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deploymentPaths } from "../app/deployment/base";

// base마다 다시 빌드해서 실행한다. 같은 산출물을 다른 base에 mount하는 시험이 아니다.
const paths = deploymentPaths(process.env.GROVE_WEB_BASE);
const swFile = join(process.cwd(), "build/client/sw.js");

test(`deployment ${paths.base}: direct entry, deep-link refresh, assets, manifest, API exclusion`, async ({ page, request }) => {
    const failedAssets: string[] = [];
    page.on("response", (response) => {
        if (new URL(response.url()).pathname.startsWith(`${paths.base}assets/`) && !response.ok()) failedAssets.push(response.url());
    });
    await page.goto(paths.base);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByLabel("토큰")).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", paths.manifest);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", paths.icon);
    const assets = await page.locator('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]').evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("src") ?? element.getAttribute("href")!));
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) expect(new URL(asset, page.url()).pathname).toMatch(new RegExp(`^${paths.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}assets/`));
    const manifestResponse = await request.get(paths.manifest);
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json();
    for (const key of ["id", "start_url", "scope"]) {
        expect(new URL(manifest[key], manifestResponse.url()).pathname).toBe(paths.base);
    }
    for (const icon of manifest.icons) {
        const response = await request.get(new URL(icon.src, manifestResponse.url()).href);
        expect(response.ok()).toBe(true);
        expect(response.headers()["content-type"]).not.toContain("text/html");
    }
    const deep = `${paths.base}deployment-check/nested?refresh=1`;
    await page.goto(deep);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    expect(new URL(page.url()).pathname).toBe(`${paths.base}deployment-check/nested`);
    expect(new URL(page.url()).search).toBe("?refresh=1");
    expect(failedAssets).toEqual([]);
    for (const path of ["/api", "/api/not-a-version", "/api/v1/deployment-base-missing"]) {
        const response = await request.get(path, { headers: { accept: "text/html" } });
        expect(response.ok()).toBe(false);
        expect(response.headers()["content-type"] ?? "").not.toContain("text/html");
    }
    const missingAsset = await request.get(`${paths.base}assets/deployment-base-missing.js`, { headers: { accept: "text/html" } });
    expect(missingAsset.status()).toBe(404);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const registration = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration(location.href);
        return { scope: new URL(reg!.scope).pathname, script: new URL(reg!.active!.scriptURL).pathname };
    });
    expect(registration).toEqual({ scope: paths.serviceWorkerScope, script: paths.serviceWorker });
});

test(`deployment ${paths.base}: worker update waits for user choice`, async ({ page }) => {
    const original = readFileSync(swFile, "utf8");
    try {
        await page.goto(`${paths.base}deployment-check/update`);
        await expect(page.getByLabel("토큰")).toBeVisible();
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await page.getByLabel("토큰").fill("local-deployment-check-input");
        await page.evaluate(() => { (window as unknown as { deploymentMarker: boolean }).deploymentMarker = true; });
        writeFileSync(swFile, original.replace(/const VERSION = "([^"]+)"/, 'const VERSION = "$1-deployment-next"'));
        await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration(location.href))!.update(); });
        const banner = page.getByRole("status").filter({ hasText: "새 버전이 준비되었습니다" });
        await expect(banner).toBeVisible({ timeout: 15_000 });
        await expect(page.getByLabel("토큰")).toHaveValue("local-deployment-check-input");
        expect(await page.evaluate(() => (window as unknown as { deploymentMarker?: boolean }).deploymentMarker)).toBe(true);
        await banner.getByRole("button", { name: "업데이트", exact: true }).click();
        await page.waitForFunction(() => !(window as unknown as { deploymentMarker?: boolean }).deploymentMarker);
        await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
        expect(new URL(page.url()).pathname).toBe(`${paths.base}deployment-check/update`);
        const cached = await page.evaluate(async () => {
            const prefix = `grove-shell-${encodeURIComponent((await navigator.serviceWorker.getRegistration(location.href))!.scope)}-`;
            const names = (await caches.keys()).filter((name) => name.startsWith(prefix));
            const urls: string[] = [];
            for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
            return { names, urls };
        });
        expect(cached.names).toHaveLength(1);
        expect(cached.names[0]).toMatch(/-deployment-next$/);
        expect(cached.urls.length).toBeGreaterThan(0);
        for (const url of cached.urls) {
            expect(url.startsWith(paths.base)).toBe(true);
            expect(url === "/api" || url.startsWith("/api/") || url === `${paths.base}api` || url.startsWith(`${paths.base}api/`)).toBe(false);
        }
    } finally {
        writeFileSync(swFile, original);
    }
});

test(`deployment ${paths.base}: worker update applies at once without pending input`, async ({ page }) => {
    const original = readFileSync(swFile, "utf8");
    try {
        await page.goto(`${paths.base}deployment-check/auto`);
        await expect(page.getByLabel("토큰")).toBeVisible();
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await page.evaluate(() => { (window as unknown as { deploymentMarker: boolean }).deploymentMarker = true; });
        writeFileSync(swFile, original.replace(/const VERSION = "([^"]+)"/, 'const VERSION = "$1-deployment-auto"'));
        await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration(location.href))!.update(); });
        await page.waitForFunction(() => !(window as unknown as { deploymentMarker?: boolean }).deploymentMarker, undefined, { timeout: 15_000 });
        await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
        await expect(page.locator('meta[name="grove-shell-version"]')).toHaveAttribute("content", /-deployment-auto$/);
        await expect(page.getByRole("status").filter({ hasText: "새 버전이 준비되었습니다" })).toHaveCount(0);
        expect(new URL(page.url()).pathname).toBe(`${paths.base}deployment-check/auto`);
    } finally {
        writeFileSync(swFile, original);
    }
});
