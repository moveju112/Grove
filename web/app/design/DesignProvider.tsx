import { useLayoutEffect, useState, type ReactNode } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { groveTheme } from "./grove";
import { groveSoftTheme } from "./grove-soft";
import { type Prefs, usePrefs } from "../state/device";

/** OS 테마는 Astryx에 맡기고 정적 HTML과 첫 hydration 상태를 일치시킨다. */
export function DesignProvider({ children }: { children: ReactNode }) {
    const prefs = usePrefs();
    const [theme, setTheme] = useState<Prefs["theme"]>("system");
    useLayoutEffect(() => setTheme(prefs.theme), [prefs.theme]);
    return <Theme theme={theme === "soft" ? groveSoftTheme : groveTheme} mode={theme === "soft" ? "light" : theme}>{children}</Theme>;
}
