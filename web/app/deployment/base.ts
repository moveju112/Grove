/**
 * 배포 base는 origin 없는 절대 경로다. 빌드 설정과 브라우저 URL이 같은 정규화를 쓴다.
 * URL/인코딩/상위 경로는 추측해서 고치지 않고 거부한다.
 */
export function normalizeBasePath(input: string | undefined): string {
    const value = input?.trim() ?? "";
    if (!value || value === "/") return "/";
    const segments = value.split("/").filter(Boolean);
    if (
        value.startsWith("//") ||
        segments.some((s) => !/^[A-Za-z0-9._~-]+$/.test(s) || s === "." || s === "..") ||
        segments[0] === "api"
    ) {
        throw new Error("GROVE_WEB_BASE must be a local path without URL syntax, dot segments, or the reserved /api prefix");
    }
    return segments.length ? `/${segments.join("/")}/` : "/";
}

export function deploymentPaths(input: string | undefined) {
    const base = normalizeBasePath(input);
    return {
        base,
        basename: base === "/" ? "/" : base.slice(0, -1),
        manifest: `${base}manifest.webmanifest`,
        icon: `${base}icon.svg`,
        appleTouchIcon: `${base}icon-192.png`,
        serviceWorker: `${base}sw.js`,
        serviceWorkerScope: base,
    } as const;
}
