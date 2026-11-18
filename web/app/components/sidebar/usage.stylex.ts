import * as stylex from "@stylexjs/stylex";

export const usageStyles = stylex.create({
    summary: {
        flexShrink: 0,
        fontSize: 11,
        lineHeight: "16px",
        borderTopWidth: 1,
        borderTopStyle: "solid",
        borderTopColor: "var(--line)",
    },
    limits: { minWidth: 0, width: "100%" },
    label: { minWidth: 0, whiteSpace: "nowrap" },
    value: { flexShrink: 0, whiteSpace: "nowrap" },
    authAction: { minHeight: 32, fontSize: "inherit", lineHeight: "inherit", whiteSpace: "nowrap" },
});
