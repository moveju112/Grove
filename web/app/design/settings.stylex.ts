import * as stylex from "@stylexjs/stylex";

export const settingsStyles = stylex.create({
    group: {
        minWidth: 0,
        borderColor: "var(--line-strong)",
        borderRadius: 12,
        overflow: "clip",
    },
    heading: {
        minHeight: 40,
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        borderBottomColor: "var(--line)",
    },
    title: {
        flexGrow: 1,
        minWidth: 0,
        margin: 0,
        fontSize: 14,
        fontWeight: 500,
        lineHeight: "20px",
    },
    content: {
        minWidth: 0,
        backgroundColor: "var(--bg)",
    },
    notice: {
        flexShrink: 0,
        fontSize: 12,
    },
    error: {
        color: "var(--err)",
    },
    scope: {
        fontSize: 12,
        flexShrink: 0,
    },
});
