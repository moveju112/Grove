import * as stylex from "@stylexjs/stylex";

// 앱 탐색과 작업 면의 팔레트. 크기·배치·스크롤은 Layout/Stack 속성이 소유한다.
export const workspaceStyles = stylex.create({
    navigation: {
        height: "100%",
        fontSize: 12,
        lineHeight: "18px",
        backgroundColor: "var(--bg)",
    },
    main: { backgroundColor: "var(--panel)" },
});
