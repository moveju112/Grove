import { createContext, useContext } from "react";

// CSS로 숨겨도 자원 수명은 유지한다. 읽음·스크롤 측정은 실제 표시 중인 pane만 수행한다.
export const PaneVisibility = createContext(true);
export const usePaneVisible = () => useContext(PaneVisibility);
