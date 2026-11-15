import * as stylex from "@stylexjs/stylex";

export const identityStyles = stylex.create({
    // Center/Stack이 크기·정렬·간격을 소유한다. Text의 inline 흐름과 native 이미지 겹침만 확장한다.
    identity: {
        display: "inline-flex",
        minWidth: 0,
        verticalAlign: "middle",
    },
    avatar: {
        position: "relative",
        flexShrink: 0,
        overflow: "hidden",
        borderRadius: "50%",
        backgroundColor: "var(--panel)",
        color: "var(--text)",
    },
    image: {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
    },
    name: {
        minWidth: 0,
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        unicodeBidi: "isolate",
    },
});
