import * as stylex from "@stylexjs/stylex";

// 서버 팔레트의 라벨 색과 탐색 행 안의 최대 폭은 Badge의 variant만으로 표현되지 않는다.
export const labelStyles = stylex.create({
    color: (color: string) => ({
        color,
        borderColor: color,
        borderWidth: 1,
        borderStyle: "solid",
        backgroundColor: "transparent",
        maxWidth: "8em",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
    }),
});
