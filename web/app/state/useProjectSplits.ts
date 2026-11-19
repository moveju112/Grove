import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authGeneration, isLoggedIn } from "../api/client";
import type { Layout } from "./layout";
import { activeProjectSplits, loadProjectSplits, projectIds, projectSplitsKey } from "./projectSplits";

export function useProjectSplits(base: string, projectId: string | null | undefined, notice: (message: string) => void) {
    const [saved, setSaved] = useState<Record<string, Layout>>({});
    const owner = useRef(authGeneration());
    const restored = useMemo(() => loadProjectSplits(localStorage, base), [base]);
    const stored = saved[base] ?? restored;
    const layout = useMemo(() => activeProjectSplits(stored, projectId), [stored, projectId]);
    const splitProjects = useMemo(() => stored ? projectIds(stored) : [], [stored]);
    // 다른 프로젝트로 이동하는 것과 프로젝트 영역을 닫는 것은 다르다.
    useEffect(() => {
        if (!stored || !isLoggedIn() || owner.current !== authGeneration()) return;
        try { localStorage.setItem(projectSplitsKey(base), JSON.stringify(stored)); }
        catch { notice("이 기기에 프로젝트 분할을 보존하지 못했습니다. 저장 공간을 확인하세요."); }
    }, [base, stored, notice]);
    const update = useCallback((f: (current: Layout) => Layout) => {
        if (!isLoggedIn() || owner.current !== authGeneration()) return;
        setSaved((cur) => ({ ...cur, [base]: f(activeProjectSplits(cur[base] ?? restored, projectId)) }));
    }, [base, projectId, restored]);
    return { layout, splitProjects, update };
}
