import * as stylex from "@stylexjs/stylex";

export const usageStyles = stylex.create({
    summary: {
        flexShrink: 0,
        fontSize: 10.5,
        lineHeight: "13px",
        paddingBlock: 5,
        borderTopWidth: 1,
        borderTopStyle: "solid",
        borderTopColor: "var(--line)",
    },
    // 계정 사이의 옅은 구분선.
    divided: {
        paddingTop: 4,
        borderTopWidth: 1,
        borderTopStyle: "solid",
        borderTopColor: "color-mix(in srgb, var(--line) 55%, transparent)",
    },
    limits: { minWidth: 0, width: "100%" },
    label: { minWidth: 0, whiteSpace: "nowrap" },
    value: { flexShrink: 0, whiteSpace: "nowrap" },
    track: { position: "relative" },
    // 한도 기간 중 지난 시간. 사용률 바가 이 눈금보다 앞서면 빨리 쓰는 중이다.
    pace: (elapsed: number) => ({
        position: "absolute",
        top: -1.5,
        bottom: -1.5,
        width: 1.5,
        borderRadius: 1,
        backgroundColor: "#d97757",
        insetInlineStart: `${elapsed}%`,
        transform: "translateX(-50%)",
        pointerEvents: "none",
    }),
    reset: { fontSize: 10.5, lineHeight: "13px", whiteSpace: "nowrap", opacity: 0.8 },
    authAction: { minHeight: 32, fontSize: "inherit", lineHeight: "inherit", whiteSpace: "nowrap" },
});
