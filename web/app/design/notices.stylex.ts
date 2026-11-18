import * as stylex from "@stylexjs/stylex";

// 전역 알림은 한 배치 안에 쌓아 입력창이나 다른 알림을 덮지 않는다.
export const noticeStyles = stylex.create({
    loading: { position: "fixed", inset: "0 0 auto", zIndex: 1000, pointerEvents: "none" },
    global: {
        position: "fixed",
        zIndex: 40,
        top: "calc(env(safe-area-inset-top, 0px) + 56px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: "max-content",
        maxWidth: "min(40rem, calc(100vw - 24px))",
        maxHeight: "min(35dvh, 20rem)",
        overflowY: "auto",
        pointerEvents: "none",
        backgroundColor: "var(--panel)",
        borderRadius: 12,
    },
    lifecycle: { flexShrink: 0, pointerEvents: "none" },
    passiveConnection: { pointerEvents: "none" },
    update: { flexShrink: 0, minWidth: 0, maxWidth: "100%", pointerEvents: "auto" },
});
