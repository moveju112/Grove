import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

// 전문 편집기와 공용 UI도 같은 팔레트를 사용한다. 새싹의 도형과 초록색은 보존한다.
const uiFont = {
    family: "Pretendard",
    fallbacks: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif',
};
export const uiFontStack = `"${uiFont.family}", ${uiFont.fallbacks}`;
const typography = {
    "--font-family-body": uiFontStack,
    "--font-family-heading": uiFontStack,
    "--text-body-size": "var(--font-size)",
    "--text-supporting-size": "0.85em",
    "--text-supporting-leading": "inherit",
    "--text-body-leading": "1.4",
    "--text-heading-1-size": "20px",
    "--text-heading-2-size": "16px",
    "--text-heading-3-size": "14px",
    "--spacing-4": "12px",
    "--spacing-6": "20px",
    "--spacing-8": "24px",
} as const;
const tokens = {
    ...typography,
    "--bg": ["#f7f7f8", "#14161b"],
    "--panel": ["#ffffff", "#171a20"],
    "--raised": ["#f0f0f2", "#1e222a"],
    "--hover": ["#ebebee", "#242832"],
    "--sel": ["#e6e6ea", "#2b3039"],
    "--split-bg": ["#eaf2fc", "#1d3049"],
    "--split-line": ["#2476c5", "#75b2ef"],
    "--question-bg": ["#fde8b4", "#4a3614"],
    "--line": ["#e4e4e8", "#262a33"],
    "--line-strong": ["#d4d4da", "#323743"],
    "--text": ["#1d1d1f", "#f2f3f5"],
    "--text-2": ["#48494e", "#d0d2d8"],
    "--muted": ["#68686d", "#a0a4ad"],
    "--bubble": ["#f0f0f2", "#262b35"],
    "--accent": ["#242528", "#e1e3e8"],
    "--accent-weak": ["#ececee", "#2b3039"],
    "--accent-ink": ["#343539", "#d0d2d8"],
    "--warn": ["#8f5a0c", "#f0b429"],
    "--err": ["#c8372a", "#ff6b5e"],
    "--ok": ["#2f9e63", "#4cc38a"],
    "--focus": ["#51545c", "#b6bdcd"],
    "--on-accent": ["#ffffff", "#14161b"],
    "--warn-weak": ["#fdf3e3", "#2e2615"],
    "--err-weak": ["#fcefed", "#3a1f1d"],
    "--ok-weak": ["#e6f4ec", "#183126"],
    "--brand": ["#2f7d55", "#5fbf8a"],
    "--shadow-float": ["0 8px 24px rgb(0 0 0 / 0.08)", "0 12px 32px rgb(0 0 0 / 0.35)"],
    "--color-background-body": "var(--bg)",
    "--color-background-surface": "var(--panel)",
    "--color-background-wash": "var(--bg)",
    "--color-text-primary": "var(--text)",
    "--color-text-secondary": "var(--muted)",
    "--color-accent": "var(--accent)",
} as const;

const quietButton = {
    backgroundColor: "transparent",
    borderColor: "transparent",
    color: "var(--text)",
    boxShadow: "none",
    textAlign: "start",
    ":hover": { backgroundColor: "var(--hover)" },
};

export default defineTheme({
    name: "grove",
    extends: neutralTheme,
    typography: {
        body: uiFont,
        heading: uiFont,
    },
    tokens,
    components: {
        drawer: {
            base: { transitionDuration: "280ms", transitionTimingFunction: "var(--motion-ease)" },
        },
        card: {
            "variant:orange": { backgroundColor: "var(--warn-weak)", color: "var(--text)" },
            "variant:yellow": { backgroundColor: "var(--warn-weak)", color: "var(--text)" },
            "variant:red": { backgroundColor: "var(--err-weak)", color: "var(--text)" },
        },
        button: {
            base: { fontSize: "13px", fontWeight: "400" },
            "size:lg": { minHeight: "44px" },
            "variant:inline-link": {
                ...quietButton, minHeight: "28px", height: "auto",
            },
            "variant:navigation": {
                ...quietButton, width: "100%", height: "32px", minHeight: "32px",
                padding: "0 var(--spacing-2)", fontSize: "12px", lineHeight: "18px",
                justifyContent: "flex-start", borderRadius: "var(--radius-element)",
                ':is([aria-current="page"])': { backgroundColor: "var(--sel)", color: "var(--text)" },
            },
            "variant:navigation+size:lg": { minHeight: "40px", height: "40px", fontSize: "var(--font-size)" },
            "variant:choice+size:lg": { minWidth: "44px", minHeight: "44px", height: "44px" },
            "variant:icon": {
                ...quietButton, width: "32px", height: "32px", minWidth: "32px", minHeight: "32px",
                padding: "0", color: "var(--muted)",
                ':is([aria-pressed="true"])': { backgroundColor: "var(--sel)", color: "var(--accent)" },
            },
            "variant:send": {
                width: "36px", height: "36px", minWidth: "36px", minHeight: "36px",
                padding: "0", borderRadius: "50%", backgroundColor: "var(--text)", color: "var(--panel)",
            },
            "variant:choice": {
                ...quietButton, padding: "0 var(--spacing-2)", minHeight: "32px", height: "32px",
                fontSize: "12px", color: "var(--muted)",
                ':is([aria-pressed="true"])': { backgroundColor: "var(--sel)", color: "var(--text)" },
            },
            "variant:settings-menu": {
                ...quietButton, minHeight: "36px", height: "auto",
                padding: "var(--spacing-2) var(--spacing-3)", fontSize: "13px",
                justifyContent: "flex-start",
                ':is([aria-current="page"])': { backgroundColor: "var(--sel)", color: "var(--text)" },
            },
            "variant:menu": {
                ...quietButton, minWidth: "32px", minHeight: "32px", height: "32px",
                padding: "0 var(--spacing-2)", color: "var(--muted)",
            },
            "variant:disclosure": {
                ...quietButton, minHeight: "32px", height: "auto", maxWidth: "100%",
                fontSize: "12px", justifyContent: "flex-start",
            },
        },
        icon: {
            "size:xsm": { width: "12px", height: "12px" },
            "size:sm": { width: "16px", height: "16px" },
            "size:md": { width: "18px", height: "18px" },
            "size:lg": { width: "24px", height: "24px" },
        },
        text: {
            "color:brand": { color: "var(--brand)" },
            "color:error": { color: "var(--err)" },
            "color:warning": { color: "var(--warn)" },
        },
        heading: {
            "type:panel": { fontSize: "14px", fontWeight: "500", lineHeight: "20px", margin: "0" },
            "type:navigation": { fontSize: "12px", fontWeight: "500", lineHeight: "18px", margin: "0" },
        },
        "chat-message": {
            base: { fontSize: "var(--font-size)", lineHeight: "1.5" },
        },
        "chat-message-bubble": {
            "sender:user": {
                backgroundColor: "var(--bubble)", color: "var(--text)",
                borderRadius: "16px 16px 4px 16px", padding: "var(--spacing-2) var(--spacing-3)",
            },
        },
        "list-item": {
            base: {
                ':has(button[data-variant="navigation"])': { paddingBlock: "0", minHeight: "32px" },
            },
        },
    },
    adaptations: { rules: [{ when: { pointer: "coarse" }, value: { tokens: typography } }] },
});
