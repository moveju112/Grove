import * as stylex from "@stylexjs/stylex";

// xterm이 측정하는 host는 남는 높이를 채운다. 보조 키는 터치 기기에서만 필요하다.
export const terminalLayout = stylex.create({
    host: {
        flexGrow: 1,
        minHeight: "12rem",
        overflow: "hidden",
        backgroundColor: "#111",
        borderRadius: "var(--radius-element)",
    },
    keys: { display: { default: "flex", "@media (pointer: fine)": "none" } },
});
