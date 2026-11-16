import * as stylex from "@stylexjs/stylex";

// 상단 바에는 현재 프로젝트 이름 한 줄만 표시한다.
export const navigationStyles = stylex.create({
    root: { flexGrow: 1, minWidth: 0, overflow: "hidden" },
    project: { minWidth: 0, maxWidth: "100%", overflow: "hidden", fontWeight: 600 },
});
