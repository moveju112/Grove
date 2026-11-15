import * as stylex from "@stylexjs/stylex";

// Grid는 동일 폭/자동 재배치 열만 제공한다. 파일 탐색의 30% 열은 앱 레이아웃 계약이다.
export const fileLayout = stylex.create({
    columns: {
        gridTemplateColumns: {
            default: "minmax(180px, 30%) minmax(0, 1fr)",
            "@media (max-width: 720px)": "minmax(0, 1fr)",
        },
        minHeight: 0,
    },
    fill: { flexGrow: 1, minHeight: 0 },
    tree: { backgroundColor: "var(--bg)", borderRadius: "var(--radius-container)" },
});
