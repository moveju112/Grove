import { defineTheme } from "@astryxdesign/core/theme";
import grove from "./grove.theme";

// 1안 밝은 회색과 3안 차콜을 각각 고정 라이트·다크 모드로 적용한다.
const tokens = {
    "--bg": ["#d4d4d4", "#242830"],
    "--panel": ["#e0e0e0", "#2d323b"],
    "--raised": ["#d9d9d9", "#353c47"],
    "--hover": ["#cecece", "#3b4451"],
    "--sel": ["#c7c7c7", "#414b59"],
    "--question-bg": ["#e6cd96", "#55421d"],
    "--line": ["#c7c7c7", "#414b59"],
    "--line-strong": ["#b5b5b5", "#515c6c"],
    "--text": ["#3b3b3b", "#e1e5eb"],
    "--text-2": ["#444444", "#d0d6df"],
    "--muted": ["#4e4e4e", "#c4c9cf"],
    "--bubble": ["#cecece", "#3b4451"],
    "--accent": "var(--text)",
    "--accent-weak": "var(--sel)",
    "--accent-ink": "var(--text-2)",
    "--on-accent": "var(--panel)",
    "--warn": ["#6e400c", "#f0b429"],
    "--err": ["#942819", "#ff9186"],
    "--ok": ["#1e593a", "#8fcaa6"],
    "--color-background-card": "var(--raised)",
    "--color-background-popover": "var(--panel)",
    "--color-background-muted": "var(--raised)",
    "--color-border": "var(--line)",
    "--color-border-emphasized": "var(--line-strong)",
    "--color-text-accent": "var(--accent-ink)",
    "--color-on-accent": "var(--on-accent)",
    "--color-syntax-background": "light-dark(#dbdbdb, #242932)",
} as const;

export default defineTheme({ name: "grove-comfort", extends: grove, tokens });
