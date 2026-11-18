import { createContext, useContext, useSyncExternalStore } from "react";

// CSS로 숨겨도 자원 수명은 유지한다. 읽음·스크롤 측정은 실제 표시 중인 pane만 수행한다.
export const PaneVisibility = createContext(true);
export const usePaneVisible = () => useContext(PaneVisibility);

const pageVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const subscribePage = (notify: () => void) => {
    document.addEventListener("visibilitychange", notify);
    return () => document.removeEventListener("visibilitychange", notify);
};

// 화면 상태·초안은 유지하고 읽기 구독만 멈춘다. SSR에서는 브라우저의 초기 표시 상태를 기다린다.
export const usePageVisible = () => useSyncExternalStore(subscribePage, pageVisible, () => true);
