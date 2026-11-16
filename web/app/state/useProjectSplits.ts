import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authGeneration, isLoggedIn } from "../api/client";
import type { Layout } from "./layout";
import { activeProjectSplits, loadProjectSplits, projectSplitsKey } from "./projectSplits";

export function useProjectSplits(base: string, projectId: string | null | undefined, notice: (message: string) => void) {
    const [saved, setSaved] = useState<Record<string, Layout>>({});
    const owner = useRef(authGeneration());
    const restored = useMemo(() => loadProjectSplits(localStorage, base), [base]);
    const layout = useMemo(() => activeProjectSplits(saved[base] ?? restored, projectId), [saved, base, restored, projectId]);
    // 기기별 배치 선택이며 서버의 프로젝트·세션 상태는 바꾸지 않는다.
    useEffect(() => {
        if (!projectId || !isLoggedIn() || owner.current !== authGeneration()) return;
        try { localStorage.setItem(projectSplitsKey(base), JSON.stringify(layout)); }
        catch { notice("이 기기에 프로젝트 분할을 보존하지 못했습니다. 저장 공간을 확인하세요."); }
        setSaved((cur) => cur[base] === layout ? cur : { ...cur, [base]: layout });
    }, [base, layout, projectId, notice]);
    const update = useCallback((f: (current: Layout) => Layout) => {
        if (!isLoggedIn() || owner.current !== authGeneration()) return;
        setSaved((cur) => ({ ...cur, [base]: f(activeProjectSplits(cur[base] ?? restored, projectId)) }));
    }, [base, projectId, restored]);
    return { layout, update };
}
