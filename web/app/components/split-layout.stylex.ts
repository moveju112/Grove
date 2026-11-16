import * as stylex from "@stylexjs/stylex";

// 비율은 서버에 저장한 중첩 배치의 값이다. Resizable의 픽셀 선택 모델로 대체하지 않는다.
export const splitStyles = stylex.create({
    fill: { flexGrow: 1, minWidth: 0, minHeight: 0 },
    projectRoot: { position: "relative", minWidth: 0, minHeight: 0 },
    projectPane: (x: number, y: number, width: number, height: number) => ({
        position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`,
        boxSizing: "border-box", minWidth: 0, minHeight: 0,
        paddingLeft: x > 0 ? 3 : 0, paddingTop: y > 0 ? 3 : 0,
        paddingRight: x + width < 0.999999 ? 3 : 0, paddingBottom: y + height < 0.999999 ? 3 : 0,
    }),
    projectDivider: (left: string, top: string, width: string, height: string, row: boolean) => ({
        position: "absolute", left, top, width, height, zIndex: 2, transform: row ? "translateX(-50%)" : "translateY(-50%)",
    }),
    projectName: { maxWidth: 100, flexShrink: 0, paddingInline: "var(--spacing-2)", fontSize: 12 },
    child: (basis: string) => ({ flexBasis: basis, flexGrow: 0, flexShrink: 1, minWidth: "8em", minHeight: "6em" }),
    divider: {
        position: "relative", flexBasis: 6, flexGrow: 0, flexShrink: 0,
        backgroundColor: "transparent", touchAction: "none", alignSelf: "stretch",
        "::after": { content: '""', position: "absolute", backgroundColor: "var(--line)" },
        ":hover::after": { backgroundColor: "var(--accent)" },
        ":focus::after": { backgroundColor: "var(--accent)" },
    },
    horizontal: { cursor: "col-resize", width: 6, height: "auto", "::after": { inset: "0 2.5px" } },
    vertical: { cursor: "row-resize", height: 6, width: "auto", "::after": { inset: "2.5px 0" } },
    pane: {
        position: "relative", flexGrow: 1, minWidth: 0, minHeight: 0,
        backgroundColor: "var(--panel)", borderWidth: 1, borderStyle: "solid", borderColor: "transparent",
        ':is([data-focused="true"])': { borderColor: "var(--accent-weak)" },
    },
    drop: {
        position: "absolute", zIndex: 5, pointerEvents: "none", backgroundColor: "var(--accent-weak)",
        borderWidth: 2, borderStyle: "dashed", borderColor: "var(--accent)", opacity: 0.7, inset: 0,
        ':is([data-zone="left"])': { right: "50%" },
        ':is([data-zone="right"])': { left: "50%" },
        ':is([data-zone="top"])': { bottom: "50%" },
        ':is([data-zone="bottom"])': { top: "50%" },
    },
    tabs: { flexShrink: 0, minWidth: 0, backgroundColor: "var(--bg)", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "var(--line)" },
    tabList: { flexGrow: 1, flexBasis: 0, minWidth: 0, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "thin" },
    tabActions: { flexShrink: 0, paddingInline: "var(--spacing-1)" },
    splitActions: {
        flexShrink: 0, borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)",
        borderRadius: 8, backgroundColor: "var(--panel)",
    },
    splitAction: {
        flexShrink: 0, width: 32, minWidth: 32, height: 30, minHeight: 30,
        paddingInline: 0, paddingBlock: 0, borderRadius: 0, color: "var(--text)",
    },
    splitActionStart: { borderTopLeftRadius: 7, borderBottomLeftRadius: 7 },
    splitActionEnd: {
        borderTopRightRadius: 7, borderBottomRightRadius: 7,
        borderInlineStartWidth: 1, borderInlineStartStyle: "solid", borderInlineStartColor: "var(--line)",
    },
    tab: {
        flexShrink: 0, width: "auto", minWidth: 128, maxWidth: 208, height: 32, borderRadius: 0, color: "var(--muted)",
        "--tab-close-opacity": 0,
        borderBottomWidth: 2, borderBottomStyle: "solid", borderBottomColor: "transparent",
        borderInlineEndWidth: 1, borderInlineEndStyle: "solid", borderInlineEndColor: "var(--line)",
        ":hover": { backgroundColor: "var(--hover)", "--tab-close-opacity": 1 },
        ":focus-within": { "--tab-close-opacity": 1 },
        ':is([aria-selected="true"])': { backgroundColor: "var(--panel)", color: "var(--text)", borderBottomColor: "var(--text)", fontWeight: 600, "--tab-close-opacity": 1 },
    },
    title: { flexGrow: 1, flexBasis: "auto", minWidth: 0, height: "100%", minHeight: 0, borderRadius: 0, overflow: "hidden", paddingInline: "var(--spacing-3)", whiteSpace: "nowrap", cursor: "grab", fontSize: 12, color: "inherit", fontWeight: "inherit" },
    titleText: { minWidth: 0, flexGrow: 1, textAlign: "start" },
    close: { flexShrink: 0, width: 24, minWidth: 24, height: 24, minHeight: 24, marginInlineEnd: "var(--spacing-1)", opacity: "var(--tab-close-opacity)" },
    body: {
        "--pane-inset": "var(--spacing-3)",
        padding: "var(--pane-inset)",
        // 입력 표면이 하단 가림 영역을 소유한다. scroll container는 추가 여백을 만들지 않는다.
        ':has(> [data-testid="session-view"]), :has(> [data-testid="project-view"])': { paddingBottom: 0 },
        containerType: "inline-size",
    },
});
