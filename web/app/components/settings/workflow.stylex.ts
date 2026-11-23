import * as stylex from "@stylexjs/stylex";

export const workflowStyles = stylex.create({
    row: {
        minWidth: 0,
        borderColor: "var(--line)",
    },
    header: { minHeight: 36, paddingInline: 12 },
    label: { minWidth: 0, flex: "1 1 auto", fontWeight: 600 },
    icon: { flexShrink: 0, display: "inline-flex" },
    actions: { flexShrink: 0 },
    details: {
        minWidth: 0,
        backgroundColor: "var(--bg)",
        borderTopWidth: 1,
        borderTopStyle: "solid",
        borderTopColor: "var(--line)",
    },
    fields: {
        gridTemplateColumns: {
            default: "minmax(0, 2fr) minmax(0, 1fr)",
            "@container settings (max-width: 680px)": "minmax(0, 1fr)",
        },
    },
    field: { minWidth: 0 },
    statuses: {
        paddingInline: { default: 0, ':not(:empty)': 12 },
        paddingBlockEnd: { default: 0, ':not(:empty)': 8 },
    },
});
