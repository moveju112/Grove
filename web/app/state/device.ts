import { useEffect, useState } from "react";
import { DEFAULT_RECENT_WINDOW, DEFAULT_RECENT_WINDOWS, isRecentWindow, normalizeRecentWindows, type RecentWindow } from "./recentWindow";
// 기기 식별(레이아웃·초안 사본용)과 기기 로컬 설정. 서버 비밀은 저장하지 않는다.

const ID_KEY = "grove.device.id";
const PREF_KEY = "grove.device.prefs";

export function deviceId(): string {
    let id = localStorage.getItem(ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        id = "d-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
        localStorage.setItem(ID_KEY, id);
    }
    return id;
}

export function isNarrow(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
}

/// 레이아웃은 넓은 화면과 좁은 화면을 따로 저장한다(PC 분할을 폰에 강제로 복사하지 않음).
export function layoutKey(): string {
    return `${deviceId()}${isNarrow() ? "-narrow" : ""}`;
}

export function deviceName(): string {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : /Mac/.test(ua) ? "Mac" : "기기";
    const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "브라우저";
    return `${br} · ${os}`;
}

/// 이 기기 표시 설정. reasoning: 생각 과정 표시(접기·숨김·펼침), answerOnly: 답만(도구·실행 기록 숨김), expandTools: 도구 세부를 펼친 채로.
export type Prefs = {
    theme: "system" | "light" | "dark" | "soft";
    fontSize: number;
    enterToSend: boolean;
    reasoning: "collapsed" | "hidden" | "expanded";
    answerOnly: boolean;
    expandTools: boolean;
    clock: "system" | "24h" | "12h";
    timeStyle: "absolute" | "relative";
    notifyDone: boolean;
    notifyApproval: boolean;
    notifyServer: boolean;
    notifySound: boolean;
    recentWindows: RecentWindow[];
    recentWindow: RecentWindow | "all";
};
export const defaultPrefs: Prefs = {
    theme: "system", fontSize: 14, enterToSend: false, reasoning: "collapsed", answerOnly: false, expandTools: false, clock: "system", timeStyle: "absolute",
    notifyDone: false, notifyApproval: false, notifyServer: false, notifySound: false,
    recentWindows: [...DEFAULT_RECENT_WINDOWS], recentWindow: DEFAULT_RECENT_WINDOW,
};
const CLOCKS: readonly Prefs["clock"][] = ["system", "24h", "12h"];
const TIME_STYLES: readonly Prefs["timeStyle"][] = ["absolute", "relative"];
export function restoredPrefs(current: Prefs, expected: Prefs, fields: (keyof Prefs)[]): Prefs {
    // 배열 값도 있으므로 값으로 비교한다.
    if (fields.some((key) => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) throw new Error("확인 후 기기 설정이 바뀌었습니다. 다시 비교하세요.");
    return { ...current, ...Object.fromEntries(fields.map((key) => [key, defaultPrefs[key]])) };
}
const PREFS_EVENT = "grove-prefs";

export function loadPrefs(): Prefs {
    try {
        const prefs = { ...defaultPrefs, ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as Partial<Prefs>) };
        // 다른 버전이 남긴 알 수 없는 시간 형식은 기본값으로 읽는다(저장값은 사용자가 바꿀 때까지 그대로 둔다).
        if (!CLOCKS.includes(prefs.clock)) prefs.clock = defaultPrefs.clock;
        if (!TIME_STYLES.includes(prefs.timeStyle)) prefs.timeStyle = defaultPrefs.timeStyle;
        prefs.recentWindows = normalizeRecentWindows(Array.isArray(prefs.recentWindows) ? prefs.recentWindows : []);
        if (prefs.recentWindow !== "all" && !isRecentWindow(prefs.recentWindow)) prefs.recentWindow = defaultPrefs.recentWindow;
        return prefs;
    } catch {
        return defaultPrefs;
    }
}

export function savePrefs(p: Prefs) {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
    applyPrefs(p);
    window.dispatchEvent(new Event(PREFS_EVENT));
}

/// 설정이 바뀌면(같은 창의 다른 pane, 다른 탭) 다시 그린다.
export function usePrefs(): Prefs {
    const [p, setP] = useState<Prefs>(loadPrefs);
    useEffect(() => {
        const on = () => setP(loadPrefs());
        const onStorage = (e: StorageEvent) => {
            if (e.key === PREF_KEY) on();
        };
        window.addEventListener(PREFS_EVENT, on);
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener(PREFS_EVENT, on);
            window.removeEventListener("storage", onStorage);
        };
    }, []);
    return p;
}

/// 실제 적용되는 테마(system이면 OS 설정).
export function effectiveTheme(t: Prefs["theme"]): "light" | "dark" | "soft" {
    if (t !== "system") return t;
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// 주소창·PWA 상단 색은 각 테마의 바탕(--bg)과 같게 둔다.
const THEME_COLOR = { light: "#f7f7f8", dark: "#14161b", soft: "#e9ebee" } as const;
let osWatch: MediaQueryList | null = null;

export function applyPrefs(p: Prefs) {
    document.documentElement.dataset.theme = p.theme;
    document.documentElement.dataset.astryxTheme = p.theme === "soft" ? "grove-soft" : "grove";
    // 브라우저 주소창·PWA 상단 색도 테마에 맞춘다. system이면 OS 전환을 따라간다.
    const meta = document.querySelector('meta[name="theme-color"]');
    const sync = () => meta?.setAttribute("content", THEME_COLOR[effectiveTheme(loadPrefs().theme)]);
    sync();
    if (!osWatch && typeof matchMedia === "function") {
        osWatch = matchMedia("(prefers-color-scheme: dark)");
        osWatch.addEventListener("change", sync);
    }
    document.documentElement.style.setProperty("--font-size", `${p.fontSize}px`);
}
