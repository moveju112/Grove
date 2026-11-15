import * as stylex from "@stylexjs/stylex";

// Breadcrumbs의 항목 폭·모바일 중복 숨김은 앱의 상단 바 예산에 따른다.
export const navigationStyles = stylex.create({
    root: { flexGrow: 1, minWidth: 0 },
    trail: { flexGrow: 1, minWidth: 0, overflow: "hidden" },
    host: { maxWidth: "24%", display: { default: "flex", "@media (max-width: 760px)": "none" } },
    browse: { flexShrink: 0, display: { default: "flex", "@media (max-width: 760px)": "none" } },
    item: { minWidth: 0, maxWidth: "28%", overflow: "hidden" },
    current: { flexGrow: 1, maxWidth: "none" },
    // 현재 대화·프로젝트 제목은 본문에 이미 있다. 보조기술에는 현재 위치를 유지한다.
    duplicate: {
        position: { default: null, "@media (max-width: 760px)": "absolute" },
        width: { default: null, "@media (max-width: 760px)": 1 },
        height: { default: null, "@media (max-width: 760px)": 1 },
        overflow: { default: null, "@media (max-width: 760px)": "hidden" },
        clipPath: { default: null, "@media (max-width: 760px)": "inset(50%)" },
        whiteSpace: { default: null, "@media (max-width: 760px)": "nowrap" },
    },
    pane: { flexShrink: 0 },
});
