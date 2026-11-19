import * as stylex from "@stylexjs/stylex";

export const SPLIT_DIVIDER_SIZE = 6;
export const PANE_REVEAL_DURATION = 1000;
const TAB_ROW_HEIGHT = 32;
const compactTabs = "@container split-pane (max-width: 192px)";
// 원 위의 호를 옮기는 대신 원 전체를 돌린다. 모양은 같고 transform만 바뀌어 메인 스레드가 다시 그리지 않는다.
const tabSpin = stylex.keyframes({
    from: { transform: "rotate(0deg)" },
    to: { transform: "rotate(360deg)" },
});
const recentReveal = stylex.keyframes({
    from: { opacity: 1 },
    to: { opacity: 0 },
});

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
    projectName: { maxWidth: 100, flexShrink: 0, paddingInline: "var(--spacing-2)", fontSize: 12, lineHeight: `${TAB_ROW_HEIGHT}px` },
    child: (basis: string) => ({ flexBasis: basis, flexGrow: 0, flexShrink: 1, minWidth: 0, minHeight: 0 }),
    divider: {
        position: "relative", flexBasis: SPLIT_DIVIDER_SIZE, flexGrow: 0, flexShrink: 0,
        backgroundColor: "transparent", touchAction: "none", alignSelf: "stretch",
        "::after": { content: '""', position: "absolute", backgroundColor: "var(--line)" },
        ":hover::after": { backgroundColor: "var(--accent)" },
        ":focus::after": { backgroundColor: "var(--accent)" },
    },
    horizontal: { cursor: "col-resize", width: SPLIT_DIVIDER_SIZE, height: "auto", "::after": { inset: "0 2.5px" } },
    vertical: { cursor: "row-resize", height: SPLIT_DIVIDER_SIZE, width: "auto", "::after": { inset: "2.5px 0" } },
    pane: {
        position: "relative", flexGrow: 1, minWidth: 0, minHeight: 0,
        containerType: "inline-size", containerName: "split-pane",
        backgroundColor: "var(--panel)", borderWidth: 1, borderStyle: "solid", borderColor: "transparent",
        ':is([data-focused="true"])': { borderColor: "var(--accent-weak)" },
    },
    recentReveal: {
        position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none",
        borderWidth: 2, borderStyle: "solid", borderColor: "var(--focus)",
        animationName: { default: "none", "@media (prefers-reduced-motion: no-preference)": recentReveal },
        animationDuration: `${PANE_REVEAL_DURATION / 2}ms`, animationIterationCount: 2,
        animationTimingFunction: "ease-in", animationFillMode: "forwards",
    },
    viewport: { position: "relative", flexGrow: 1, minWidth: 0, minHeight: 0 },
    drop: {
        position: "absolute", zIndex: 5, pointerEvents: "none", backgroundColor: "var(--accent-weak)",
        borderWidth: 2, borderStyle: "dashed", borderColor: "var(--accent)", opacity: 0.7, inset: 0,
        ':is([data-zone="left"])': { right: "50%" },
        ':is([data-zone="right"])': { left: "50%" },
        ':is([data-zone="top"])': { bottom: "50%" },
        ':is([data-zone="bottom"])': { top: "50%" },
    },
    tabs: {
        flexShrink: 0, minWidth: 0, backgroundColor: "var(--bg)", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "var(--line)",
        // 폭이 좁을 때도 탭과 조작 버튼을 모두 탭 줄 안에서 스크롤해 접근한다.
        overflowX: { default: "visible", [compactTabs]: "scroll" },
        overflowY: { default: "visible", [compactTabs]: "hidden" },
        scrollbarWidth: "thin",
    },
    // 클래식 가로 스크롤바 자리를 미리 확보해 탭이 넘쳐도 본문 시작선이 움직이지 않게 한다.
    tabList: {
        flexGrow: 0, flexShrink: { default: 1, [compactTabs]: 0 }, flexBasis: "auto", minWidth: 0, minHeight: TAB_ROW_HEIGHT,
        overflowX: { default: "scroll", [compactTabs]: "visible" },
        overflowY: { default: "hidden", [compactTabs]: "visible" }, scrollbarWidth: "thin",
    },
    emptyList: { maxWidth: 324 },
    emptyHeader: { paddingBlockEnd: "var(--spacing-2)", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "var(--line)" },
    emptyItem: { gap: "var(--spacing-3)", borderRadius: 0, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "var(--line)" },
    emptyLabel: { flexGrow: 1, textAlign: "start" },
    emptySettings: { gap: "var(--spacing-1)", fontSize: 12, color: "var(--muted)", textDecoration: "none" },
    newConversation: { flexShrink: 0, width: 32, minWidth: 32, height: TAB_ROW_HEIGHT, minHeight: TAB_ROW_HEIGHT },
    tabActions: { flexShrink: 0, minHeight: TAB_ROW_HEIGHT, marginInlineStart: "auto", paddingInline: "var(--spacing-1)" },
    tab: {
        flexShrink: 0, width: "auto", minWidth: 128, maxWidth: 208, height: TAB_ROW_HEIGHT, borderRadius: 0, color: "var(--muted)",
        "--tab-close-opacity": 0,
        borderBottomWidth: 2, borderBottomStyle: "solid", borderBottomColor: "transparent",
        borderInlineEndWidth: 1, borderInlineEndStyle: "solid", borderInlineEndColor: "var(--line)",
        ":hover": { backgroundColor: "var(--hover)", "--tab-close-opacity": 1 },
        ":focus-within": { "--tab-close-opacity": 1 },
        ':is([aria-selected="true"])': { backgroundColor: "var(--panel)", color: "var(--text)", borderBottomColor: "var(--text)", fontWeight: 600, "--tab-close-opacity": 1 },
    },
    title: { flexGrow: 1, flexBasis: "auto", minWidth: 0, height: "100%", minHeight: 0, borderRadius: 0, overflow: "hidden", paddingInline: "var(--spacing-3)", whiteSpace: "nowrap", cursor: "grab", fontSize: 12, color: "inherit", fontWeight: "inherit" },
    titleText: { minWidth: 0, flexGrow: 1, textAlign: "start" },
    tabStatus: { display: "inline-flex", flexShrink: 0, width: 12, height: 12, marginInlineStart: "var(--spacing-1)", color: "var(--text-2)" },
    tabRing: { fill: "none", stroke: { default: "currentColor", "@media (forced-colors: active)": "CanvasText" }, strokeWidth: 1.5 },
    tabRingTrack: { opacity: { default: 1, "@media (prefers-reduced-motion: no-preference)": 0.32 } },
    tabRingSpin: {
        animationName: { default: "none", "@media (prefers-reduced-motion: no-preference)": tabSpin },
        animationDuration: "1.3s", animationTimingFunction: "linear", animationIterationCount: "infinite",
    },
    tabRingSweep: {
        display: { default: "none", "@media (prefers-reduced-motion: no-preference)": "inline" },
        strokeDasharray: "28 72", strokeLinecap: "round",
    },
    close: { flexShrink: 0, width: 24, minWidth: 24, height: 24, minHeight: 24, marginInlineEnd: "var(--spacing-1)", opacity: "var(--tab-close-opacity)" },
    body: {
        "--pane-inset": "var(--spacing-3)",
        padding: "var(--pane-inset)",
        // 입력 표면이 하단 가림 영역을 소유한다. scroll container는 추가 여백을 만들지 않는다.
        ':has(> [data-testid="session-view"]), :has(> [data-testid="project-view"])': {
            paddingBottom: 0,
            // 채팅 pane은 세로 스크롤만 소유한다. 넓은 표·코드 등은 자체 viewport에서 움직인다.
            overflowX: "hidden",
        },
        containerType: "inline-size",
    },
});
