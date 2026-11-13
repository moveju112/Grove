import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deploymentPaths, normalizeBasePath } from "./base";

describe("deployment base", () => {
    it.each([
        [undefined, "/"], ["", "/"], [" / ", "/"], ["grove", "/grove/"],
        ["/grove", "/grove/"], ["/grove/", "/grove/"],
        [" /grove//nested/// ", "/grove/nested/"],
    ])("normalizes %s to %s", (input, expected) => {
        expect(normalizeBasePath(input)).toBe(expected);
    });

    it.each([
        "//host/grove", "https://host/grove", "./", "/../grove", "/grove/./",
        "/grove/%2e%2e/", "/grove/%2f/", "/grove?x=1", "/grove#x", "/grove\\x",
        "/grove/\n/x", "/api", "/api/v1",
    ])("rejects ambiguous or reserved input %s", (input) => {
        expect(() => normalizeBasePath(input)).toThrow("GROVE_WEB_BASE");
    });

    it.each(["/", "/grove/", "/teams/grove/"])("keeps URLs and manifest within %s", (base) => {
        const paths = deploymentPaths(base);
        expect(paths).toEqual({
            base, basename: base === "/" ? "/" : base.slice(0, -1),
            manifest: `${base}manifest.webmanifest`, icon: `${base}icon.svg`,
            appleTouchIcon: `${base}icon-192.png`,
            serviceWorker: `${base}sw.js`, serviceWorkerScope: base,
        });
        const manifest = JSON.parse(readFileSync(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8")) as {
            id: string; start_url: string; scope: string; icons: { src: string }[];
        };
        const manifestUrl = `https://grove.invalid${paths.manifest}`;
        for (const key of ["id", "start_url", "scope"] as const) {
            expect(new URL(manifest[key], manifestUrl).pathname).toBe(base);
        }
        expect(manifest.icons.map((icon) => new URL(icon.src, manifestUrl).pathname))
            .toEqual([`${base}icon.svg`, `${base}icon-192.png`, `${base}icon-512.png`]);
    });
});
