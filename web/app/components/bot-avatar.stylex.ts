import * as stylex from "@stylexjs/stylex";

// 서버에 저장된 봇별 사용자 색이다. Avatar의 팔레트 variant로는 임의 색을 표현할 수 없다.
export const botAvatarStyles = stylex.create({
    custom: (background: string, foreground: string) => ({ backgroundColor: background, color: foreground }),
});
