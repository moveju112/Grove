import * as stylex from "@stylexjs/stylex";

export const settingsStyles = stylex.create({
    layout: {
        marginInline: "auto",
        containerName: "settings",
        containerType: "inline-size",
        alignContent: "start",
        gridTemplateColumns: {
            default: "minmax(160px, 220px) minmax(0, 1fr)",
            "@media (max-width: 760px)": "minmax(0, 1fr)",
            "@container (max-width: 680px)": "minmax(0, 1fr)",
        },
    },
    navigation: {
        position: "sticky", top: "calc(-1 * var(--pane-inset))", zIndex: 3, backgroundColor: "var(--panel)",
        marginBlockStart: "calc(-1 * var(--pane-inset))",
        paddingBlockStart: "var(--pane-inset)",
        gridColumn: { default: null, "@container settings (max-width: 680px)": "1 / -1" },
        gridRow: { default: null, "@container settings (max-width: 680px)": "1" },
    },
    menu: {
        flexDirection: { default: "column", "@container settings (max-width: 680px)": "row" },
        overflowX: { default: null, "@container settings (max-width: 680px)": "auto" },
    },
    menuItem: { flexShrink: 0 },
    body: {
        minWidth: 0, alignContent: "start", overflowWrap: "anywhere",
        gridColumn: { default: null, "@container settings (max-width: 680px)": "1 / -1" },
        gridRow: { default: null, "@container settings (max-width: 680px)": "2" },
    },
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
    },
    content: {
        minWidth: 0,
        backgroundColor: "var(--bg)",
    },
    notice: {
        flexShrink: 0,
        fontSize: 12,
    },
    scope: {
        fontSize: 12,
        flexShrink: 0,
    },
});
