import { useLayoutEffect, useState, type ReactNode } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import korean from "@astryxdesign/core/locales/ko-KR.generated.js";
import { groveTheme } from "./grove";
import { groveSoftTheme } from "./grove-soft";
import { groveComfortTheme } from "./grove-comfort";
import { themeAppearance, type Prefs, usePrefs } from "../state/device";

const messages = { "ko-KR": korean };
const themes = { grove: groveTheme, "grove-soft": groveSoftTheme, "grove-comfort": groveComfortTheme };

export function GroveTheme({ theme, children }: { theme: Prefs["theme"]; children: ReactNode }) {
    const { name, mode } = themeAppearance[theme];
    return <Theme theme={themes[name]} mode={mode}>{children}</Theme>;
}

/** OS 테마는 Astryx에 맡기고 정적 HTML과 첫 hydration 상태를 일치시킨다. */
export function DesignProvider({ children }: { children: ReactNode }) {
    const prefs = usePrefs("theme");
    const [theme, setTheme] = useState<Prefs["theme"]>("system");
    useLayoutEffect(() => setTheme(prefs.theme), [prefs.theme]);
    return <InternationalizationProvider locale="ko-KR" messages={messages}>
        <GroveTheme theme={theme}>{children}</GroveTheme>
    </InternationalizationProvider>;
}
