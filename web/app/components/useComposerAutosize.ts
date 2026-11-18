import { useLayoutEffect, useRef } from "react";

// 실제 입력창을 축소해 측정하면 모바일 브라우저가 대화 스크롤을 먼저 잘라 버린다.
// 같은 스타일의 비표시 입력창에서 재고, 확정된 높이만 실제 입력창에 적용한다.
export function useComposerAutosize() {
    const input = useRef<HTMLTextAreaElement>(null);
    const resize = useRef<(() => void) | null>(null);

    useLayoutEffect(() => {
        const node = input.current!;
        const mirror = document.createElement("textarea");
        mirror.rows = 1;
        mirror.tabIndex = -1;
        mirror.inert = true;
        mirror.setAttribute("aria-hidden", "true");
        Object.assign(mirror.style, {
            position: "fixed", inset: "0 auto auto -10000px", visibility: "hidden",
            pointerEvents: "none", height: "0px", minHeight: "0px", maxHeight: "none",
            overflow: "hidden", resize: "none",
        });
        node.parentElement!.appendChild(mirror);
        const measure = () => {
            const width = node.getBoundingClientRect().width;
            if (!width) return; // 숨긴 pane은 다시 보일 때 ResizeObserver가 측정한다.
            mirror.className = node.className;
            mirror.wrap = node.wrap;
            mirror.dir = node.dir;
            mirror.style.width = `${width}px`;
            mirror.value = node.value || " ";
            const style = getComputedStyle(node);
            const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
            const height = `${Math.min(mirror.scrollHeight + border, 160)}px`;
            if (node.style.height !== height) node.style.height = height;
        };
        resize.current = measure;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        document.fonts.addEventListener("loadingdone", measure);
        return () => {
            resize.current = null;
            observer.disconnect();
            document.fonts.removeEventListener("loadingdone", measure);
            mirror.remove();
        };
    }, []);

    // 입력·전송 후 비우기·부모의 글꼴/스타일 변경을 DOM에 반영한 뒤 측정한다.
    useLayoutEffect(() => { resize.current?.(); });
    return input;
}
