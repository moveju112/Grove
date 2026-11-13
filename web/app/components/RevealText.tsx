import type { CSSProperties } from "react";

/// 짧은 제목을 한 글자씩 드러낸다. 보조기술에는 완성된 문장 하나만 전달하고, 움직임 줄이기 설정에서는 바로 보인다.
export function RevealText({ text }: { text: string }) {
    return (
        <>
            <span className="sr-only">{text}</span>
            <span className="reveal-text" aria-hidden="true">
                {Array.from(text).map((ch, i) => <span key={i} style={{ "--i": i } as CSSProperties}>{ch}</span>)}
            </span>
        </>
    );
}
