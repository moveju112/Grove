import { useLayoutEffect, useRef } from "react";

// interactive-widget 미지원 브라우저도 키보드 위의 실제 표시 영역에 앱 틀을 맞춘다.
export function useAppViewport() {
    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const viewport = window.visualViewport;
        const node = root.current;
        if (!viewport || !node) return; // 미지원 환경은 CSS 100dvh를 사용한다.
        const update = () => {
            // 핀치 확대는 표시 영역만 확대하며 앱 자체의 배치는 유지한다.
            if (viewport.scale !== 1 || viewport.height <= 0) return;
            node.style.height = `${viewport.height}px`;
            node.style.top = `${Math.max(0, viewport.offsetTop)}px`;
        };
        update();
        viewport.addEventListener("resize", update);
        viewport.addEventListener("scroll", update);
        return () => {
            viewport.removeEventListener("resize", update);
            viewport.removeEventListener("scroll", update);
        };
    }, []);
    return root;
}
