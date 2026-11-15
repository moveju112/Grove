import * as stylex from "@stylexjs/stylex";

// 서랍의 수명·포커스·퇴장은 Astryx가 소유한다. 손가락을 따라가는 중간 위치만 앱이 제공한다.
export const mobilePanelStyles = stylex.create({
    dragging: (offset: number, progress: number) => ({
        transform: `translateX(${offset}%)`,
        transitionDuration: "0ms",
        "::backdrop": {
            opacity: progress,
            transitionDuration: "0ms",
        },
    }),
});
