import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

// 전문 편집기와 공용 UI도 같은 팔레트를 사용한다. 새싹의 도형과 초록색은 보존한다.
const typography = {
    "--font-family-body": '"Pretendard", sans-serif',
    "--font-family-heading": '"Pretendard", sans-serif',
    "--text-body-size": "var(--font-size)",
    "--text-supporting-size": "calc(var(--font-size) * 0.85)",
} as const;
const tokens = {
    ...typography,
    "--bg": ["#f7f7f8", "#14161b"],
    "--panel": ["#ffffff", "#171a20"],
    "--raised": ["#f0f0f2", "#1e222a"],
    "--hover": ["#ebebee", "#242832"],
    "--sel": ["#e6e6ea", "#2b3039"],
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
    "--brand": ["#2f7d55", "#5fbf8a"],
    "--shadow-float": ["0 8px 24px rgb(0 0 0 / 0.08)", "0 12px 32px rgb(0 0 0 / 0.35)"],
    "--color-background-body": "var(--bg)",
    "--color-background-surface": "var(--panel)",
    "--color-background-wash": "var(--bg)",
    "--color-text-primary": "var(--text)",
    "--color-text-secondary": "var(--muted)",
    "--color-accent": "var(--accent)",
} as const;

export default defineTheme({
    name: "grove",
    extends: neutralTheme,
    tokens,
    adaptations: { rules: [{ when: { pointer: "coarse" }, value: { tokens: typography } }] },
});
