import * as stylex from "@stylexjs/stylex";

export const questionStyles = stylex.create({
    title: { fontSize: "1.125rem", lineHeight: 1.4, overflowWrap: "anywhere" },
    option: {
        minHeight: 36, height: "auto", whiteSpace: "normal", textAlign: "start", paddingBlock: 6,
        ':is([data-current="true"])': { backgroundColor: "var(--hover)" },
        ':is([aria-pressed="true"])': { backgroundColor: "var(--sel)" },
    },
    number: {
        flexShrink: 0, minWidth: 22, textAlign: "center", fontSize: 12, borderRadius: 4,
        borderWidth: 1, borderStyle: "solid", borderColor: "var(--line-strong)", backgroundColor: "var(--panel)", color: "var(--text-2)",
    },
    copy: { minWidth: 0, flexGrow: 1, overflowWrap: "anywhere", whiteSpace: "normal" },
    footer: { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: "var(--line)", backgroundColor: "var(--bg)" },
    hint: { marginInlineStart: "auto", display: { default: "inline", "@media (pointer: coarse)": "none" } },
});
