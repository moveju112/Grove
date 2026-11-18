import * as stylex from "@stylexjs/stylex";

export const appStyles = stylex.create({
    // 본문은 pane 안에서 스크롤하고, 키보드의 자동 pan 중에도 앱 상단을 유지한다.
    viewport: { position: "fixed", top: 0, insetInline: 0 },
});
