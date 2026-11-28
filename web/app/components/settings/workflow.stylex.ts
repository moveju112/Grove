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
            default: "minmax(0, 2fr) minmax(0, 1fr) 40px",
            "@container settings (max-width: 680px)": "minmax(0, 1fr)",
        },
    },
    field: { minWidth: 0 },
    fallback: { minWidth: 0, paddingTop: 8, borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: "var(--line)" },
    // 넓은 화면은 다른 열처럼 제목 아래에, 좁은 화면은 한 줄에 둔다.
    fast: {
        display: "flex",
        gap: 8,
        flexDirection: { default: "column", "@container settings (max-width: 680px)": "row" },
        alignItems: { default: "flex-start", "@container settings (max-width: 680px)": "center" },
        justifyContent: { default: "flex-start", "@container settings (max-width: 680px)": "space-between" },
    },
    fastControl: { minHeight: { default: 36, "@container settings (max-width: 680px)": 0 }, display: "flex", alignItems: "center" },
    statuses: {
        paddingInline: { default: 0, ':not(:empty)': 12 },
        paddingBlockEnd: { default: 0, ':not(:empty)': 8 },
    },
});
