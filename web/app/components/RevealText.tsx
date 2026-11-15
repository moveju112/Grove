import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { revealStyles } from "./reveal-text.stylex";

/// 짧은 제목을 한 글자씩 드러낸다. 보조기술에는 완성된 문장 하나만 전달하고, 움직임 줄이기 설정에서는 바로 보인다.
export function RevealText({ text }: { text: string }) {
    return (
        <>
            <VisuallyHidden>{text}</VisuallyHidden>
            <GroveText type="inherit" color="inherit" aria-hidden="true" data-testid="reveal-text">
                {Array.from(text).map((ch, i) => <GroveText type="inherit" color="inherit" key={i} xstyle={revealStyles.letter(i)}>{ch}</GroveText>)}
            </GroveText>
        </>
    );
}
