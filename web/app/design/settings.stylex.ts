import * as stylex from "@stylexjs/stylex";

export const settingsStyles = stylex.create({
    areaSelector: {
        padding: 4,
        gap: 4,
        flexShrink: 0,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "var(--line-strong)",
        borderRadius: 12,
        backgroundColor: "var(--bg)",
    },
    areaTab: {
        minHeight: 52,
        paddingInline: 4,
        gap: 4,
        fontSize: "1rem",
        fontWeight: 600,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "var(--line-strong)",
        borderRadius: 8,
        color: "var(--text)",
        ':is([aria-selected="true"])': {
            backgroundColor: "var(--text)",
            borderColor: "var(--text)",
            color: "var(--panel)",
        },
    },
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
        position: "sticky", top: "calc(-1 * var(--pane-inset, 0px))", zIndex: 3, backgroundColor: "var(--panel)",
        marginBlockStart: "calc(-1 * var(--pane-inset, 0px))",
        paddingBlockStart: "var(--pane-inset, 0px)",
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
    definitionList: {
        gridTemplateColumns: {
            default: "repeat(2, minmax(0, 1fr))",
            "@container settings (max-width: 680px)": "minmax(0, 1fr)",
        },
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
