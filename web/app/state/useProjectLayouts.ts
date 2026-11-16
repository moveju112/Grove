import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, authGeneration, isLoggedIn, newKey } from "../api/client";
import * as L from "./layout";
import { LayoutPersistence } from "./layoutPersistence";
import { projectLayout, projectLayoutKey } from "./projectLayout";

type Target = Omit<L.Tab, "id">;
type How = "here" | "right" | "down";
type Entry = { base: string; projectId: string; store: LayoutPersistence; ready: Promise<void> };
const selectionKey = (base: string) => `grove.layout.selected.${base}`;

export function useProjectLayouts(base: string, notice: (message: string) => void) {
    const [saved, setSaved] = useState<Record<string, L.Layout>>({});
    const [selected, setSelected] = useState<Record<string, string | null>>({});
    const entries = useRef(new Map<string, Entry>());
    const bases = useRef(new Map<string, Promise<L.Layout | null>>());
    const stores = useRef(new Set<LayoutPersistence>());
    const owner = useRef(authGeneration());
    const closed = useRef(false);
    const active = useCallback(() => !closed.current && owner.current === authGeneration() && isLoggedIn(), []);
    const home = useMemo(() => L.emptyLayout(), [base]);
    const makeStore = useCallback((id: string, initial?: () => L.Layout) => {
        const store = new LayoutPersistence(id, {
            store: localStorage, newKey, notice, active, initial,
            get: (signal) => api.get(`/layouts/${id}`, { signal, timeoutMs: 10_000 }),
            put: ({ key, ...body }, signal) => api.put(`/layouts/${id}`, body, { key, signal, timeoutMs: 10_000 }),
        });
        stores.current.add(store);
        return store;
    }, [active, notice]);
    const loadBase = useCallback((id: string) => {
        let pending = bases.current.get(id);
        if (!pending) {
            const store = makeStore(id);
            store.restoreLocal();
            pending = store.restore().then((layout) => {
                // 원본은 이관 근거로만 읽는다. 공용 배치의 보류 저장을 다시 보내지 않는다.
                store.dispose();
                stores.current.delete(store);
                return layout;
            });
            bases.current.set(id, pending);
        }
        return pending;
    }, [makeStore]);
    const loadProject = useCallback((baseId: string, projectId: string): Entry => {
        const id = projectLayoutKey(baseId, projectId);
        const existing = entries.current.get(id);
        if (existing) return existing;
        let legacy: L.Layout | null = null;
        const store = makeStore(id, () => legacy ? projectLayout(legacy, projectId) : L.emptyLayout());
        const publish = (layout: L.Layout) => {
            if (active()) setSaved((cur) => ({ ...cur, [id]: L.withoutSettingsTabs(layout) }));
        };
        const cached = store.restoreLocal();
        if (cached) publish(cached);
        const ready = (cached ? Promise.resolve(null) : loadBase(baseId)).then(async (layout) => {
            if (!active()) return;
            legacy = layout;
            const restored = await store.restore();
            if (restored) publish(restored);
        });
        const entry = { base: baseId, projectId, store, ready };
        entries.current.set(id, entry);
        return entry;
    }, [active, loadBase, makeStore]);

    useEffect(() => {
        let stored: string | null = null;
        try { stored = localStorage.getItem(selectionKey(base)); } catch { /* 서버 배치의 위치로 복원한다. */ }
        if (stored) {
            setSelected((cur) => base in cur ? cur : { ...cur, [base]: stored });
            return;
        }
        void loadBase(base).then((legacy) => {
            if (!active()) return;
            const leaf = legacy && L.focusedLeaf(legacy);
            const projectId = leaf?.tabs.find((tab) => tab.id === leaf.active_tab)?.project_id ?? null;
            setSelected((cur) => base in cur ? cur : { ...cur, [base]: projectId });
        });
    }, [active, base, loadBase]);
    const projectId = selected[base];
    useEffect(() => {
        if (projectId) loadProject(base, projectId);
    }, [base, projectId, loadProject]);
    useEffect(() => () => {
        closed.current = true;
        for (const store of stores.current) store.dispose();
        stores.current.clear();
    }, []);

    const select = useCallback((baseId: string, id: string) => {
        if (!active()) return;
        setSelected((cur) => ({ ...cur, [baseId]: id }));
        try { localStorage.setItem(selectionKey(baseId), id); }
        catch { notice("이 기기에 선택한 프로젝트를 보존하지 못했습니다. 저장 공간을 확인하세요."); }
    }, [active, notice]);
    const updateAt = useCallback((id: string, f: (layout: L.Layout) => L.Layout) => {
        if (!active()) return;
        setSaved((cur) => {
            const current = cur[id];
            if (!current) return cur;
            const next = f(current);
            if (next === current) return cur;
            entries.current.get(id)?.store.change(next);
            return { ...cur, [id]: next };
        });
    }, [active]);
    const openAt = useCallback((source: string, target: Target, how: How = "here", restore = false) => {
        if (!target.project_id || !active()) return;
        const from = entries.current.get(source);
        const baseId = from?.base ?? source;
        const id = projectLayoutKey(baseId, target.project_id);
        // 숨긴 프로젝트에서 늦게 완료된 생성은 그 프로젝트만 갱신하고 현재 화면을 빼앗지 않는다.
        if (!from || from.projectId !== target.project_id) select(baseId, target.project_id);
        const entry = loadProject(baseId, target.project_id);
        void entry.ready.then(() => updateAt(id, (layout) => {
            if (restore && L.allTabs(layout).length > 0) return layout;
            if (how === "here" || baseId.endsWith("-narrow") || L.allTabs(layout).length === 0) return L.openResource(layout, target);
            return L.splitLeaf(layout, layout.focused_leaf, how === "right" ? "row" : "column", target);
        }));
    }, [active, loadProject, select, updateAt]);
    const flush = useCallback(() => {
        for (const entry of entries.current.values()) void entry.store.flush();
    }, []);
    const focusAt = useCallback((id: string) => {
        const entry = entries.current.get(id);
        if (entry) select(entry.base, entry.projectId);
    }, [select]);
    const projectAt = useCallback((id: string) => entries.current.get(id)?.projectId, []);
    const key = projectId ? projectLayoutKey(base, projectId) : base;
    const layouts = base in selected && !projectId ? { ...saved, [base]: home } : saved;
    return { key, projectId, layout: layouts[key], layouts, openAt, updateAt, flush, focusAt, projectAt, ensureProject: loadProject };
}
