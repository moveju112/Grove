import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, authGeneration, isLoggedIn, newKey } from "../api/client";
import * as L from "./layout";
import { LayoutPersistence, type RemoteLayout } from "./layoutPersistence";
import { projectLayout, projectLayoutKey } from "./projectLayout";
import { querySnapshot, subscribeQuery } from "./store";
import { applyWorkspaceTabs, mergeWorkspaceTabs, workspaceResumeKey, workspaceTabs, workspaceTabsKey } from "./workspaceTabs";

type Target = Omit<L.Tab, "id">;
type How = "here" | "right" | "down";
type Entry = { base: string; projectId: string; store: LayoutPersistence; ready: Promise<void>; hydrated: boolean };
type Shared = { store: LayoutPersistence; ready: Promise<L.Layout | null>; unsubscribe: () => void };
const selectionKey = (base: string) => `grove.layout.selected.${base}`;

export function useProjectLayouts(base: string, notice: (message: string) => void) {
    const [saved, setSaved] = useState<Record<string, L.Layout>>({});
    const layoutsRef = useRef<Record<string, L.Layout>>({});
    const [selected, setSelected] = useState<Record<string, string | null>>({});
    const entries = useRef(new Map<string, Entry>());
    const shared = useRef(new Map<string, Shared>());
    const bases = useRef(new Map<string, Promise<L.Layout | null>>());
    const stores = useRef(new Set<LayoutPersistence>());
    const owner = useRef(authGeneration());
    const closed = useRef(false);
    const startupBase = useRef(base);
    const resumeProject = useRef<string | undefined>(undefined);
    const active = useCallback(() => !closed.current && owner.current === authGeneration() && isLoggedIn(), []);
    const home = useMemo(() => L.emptyLayout(), [base]);
    const publish = useCallback((id: string, layout: L.Layout) => {
        if (!active() || layoutsRef.current[id] === layout) return;
        layoutsRef.current = { ...layoutsRef.current, [id]: layout };
        setSaved(layoutsRef.current);
    }, [active]);
    const projectSnapshot = useCallback((projectId: string, snapshot: L.Layout, except?: string) => {
        for (const [key, entry] of entries.current) {
            if (key === except || !entry.hydrated || entry.projectId !== projectId) continue;
            const current = layoutsRef.current[key];
            if (!current) continue;
            const next = applyWorkspaceTabs(current, snapshot, false);
            if (next === current) continue;
            entry.store.change(next);
            publish(key, next);
        }
    }, [publish]);
    const makeStore = useCallback((id: string, initial?: () => L.Layout, synchronization?: {
        get: (signal: AbortSignal) => Promise<RemoteLayout>; onRemote: (layout: L.Layout) => void;
    }) => {
        const store = new LayoutPersistence(id, {
            store: localStorage, newKey, notice, active, initial,
            get: (signal) => api.get(`/layouts/${id}`, { signal, timeoutMs: 10_000 }),
            put: ({ key, ...body }, signal) => api.put(`/layouts/${id}`, body, { key, signal, timeoutMs: 10_000 }),
            ...(synchronization && {
                ...synchronization, merge: mergeWorkspaceTabs, seed: (layout) => L.allTabs(layout).length > 0,
            }),
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
    const loadShared = useCallback((projectId: string, local: L.Layout): Shared => {
        const existing = shared.current.get(projectId);
        if (existing) return existing;
        const id = workspaceTabsKey(projectId);
        const query = `workspace-layout:${id}`;
        let initial: Promise<RemoteLayout> | undefined;
        const fetchLayout = () => api.get<RemoteLayout>(`/layouts/${id}`, { timeoutMs: 10_000 });
        const store = makeStore(id, () => workspaceTabs(local), {
            get: () => initial ??= fetchLayout(),
            onRemote: (snapshot) => projectSnapshot(projectId, snapshot),
        });
        const ready = store.restore();
        const accept = () => {
            const { data } = querySnapshot<RemoteLayout>(query);
            if (data) store.acceptRemote(data);
        };
        let first = true;
        const unsubscribe = subscribeQuery(query, () => {
            if (!first) return fetchLayout();
            first = false;
            return initial ??= fetchLayout();
        }, accept);
        void ready.then(accept);
        const result = { store, ready, unsubscribe };
        shared.current.set(projectId, result);
        return result;
    }, [makeStore, projectSnapshot]);
    const loadProject = useCallback((baseId: string, projectId: string): Entry => {
        const id = projectLayoutKey(baseId, projectId);
        const existing = entries.current.get(id);
        if (existing) return existing;
        let legacy: L.Layout | null = null;
        const store = makeStore(id, () => legacy ? projectLayout(legacy, projectId) : L.emptyLayout());
        const cached = store.restoreLocal();
        if (cached) publish(id, L.withoutSettingsTabs(cached));
        const ready = (cached ? Promise.resolve(null) : loadBase(baseId)).then(async (layout) => {
            if (!active()) return;
            legacy = layout;
            const restored = await store.restore();
            if (!restored || !active()) return;
            const local = L.withoutSettingsTabs(restored);
            const sync = loadShared(projectId, local);
            await sync.ready;
            if (!active()) return;
            const snapshot = sync.store.snapshot();
            const resume = (startupBase.current === baseId && resumeProject.current === projectId)
                || !L.allTabs(local).some((tab) => tab.kind === "session");
            const next = snapshot ? applyWorkspaceTabs(local, snapshot, resume) : local;
            entry.hydrated = true;
            if (next !== local) store.change(next);
            publish(id, next);
        });
        const entry = { base: baseId, projectId, store, ready, hydrated: false };
        entries.current.set(id, entry);
        return entry;
    }, [active, loadBase, loadShared, makeStore, publish]);

    useEffect(() => {
        let cancelled = false;
        let stored: string | null = null;
        try { stored = localStorage.getItem(selectionKey(base)); } catch { /* 서버 배치의 위치로 복원한다. */ }
        const controller = new AbortController();
        void (async () => {
            let remote: string | undefined;
            if (startupBase.current === base) {
                try {
                    const { layout } = await api.get<RemoteLayout>(`/layouts/${workspaceResumeKey}`, { signal: controller.signal, timeoutMs: 10_000 });
                    if (L.isValid(layout)) remote = L.allTabs(layout)[0]?.project_id;
                } catch { /* 연결되지 않으면 이 화면에서 마지막으로 연 프로젝트를 복원한다. */ }
            }
            let fallback = stored;
            if (!remote && !fallback && !cancelled && active()) {
                const legacy = await loadBase(base);
                const leaf = legacy && L.focusedLeaf(legacy);
                fallback = leaf?.tabs.find((tab) => tab.id === leaf.active_tab)?.project_id ?? null;
            }
            if (cancelled || !active()) return;
            resumeProject.current = remote;
            setSelected((cur) => base in cur ? cur : { ...cur, [base]: remote ?? fallback });
        })();
        return () => { cancelled = true; controller.abort(); };
    }, [active, base, loadBase]);
    const projectId = selected[base];
    useEffect(() => {
        if (projectId) loadProject(base, projectId);
    }, [base, projectId, loadProject]);
    useEffect(() => () => {
        closed.current = true;
        for (const entry of shared.current.values()) entry.unsubscribe();
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
        const entry = entries.current.get(id);
        if (!active() || !entry) return;
        const apply = () => {
            const current = layoutsRef.current[id];
            if (!active() || !current) return;
            const next = f(current);
            if (next === current) return current;
            entry.store.change(next);
            const sync = shared.current.get(entry.projectId)?.store;
            const snapshot = sync?.snapshot();
            if (sync && snapshot) {
                const edited = mergeWorkspaceTabs(current, next, snapshot);
                if (edited !== snapshot) {
                    sync.change(edited);
                    projectSnapshot(entry.projectId, edited, id);
                }
            }
            publish(id, next);
            return next;
        };
        return entry.hydrated ? apply() : entry.ready.then(apply);
    }, [active, projectSnapshot, publish]);
    const openAt = useCallback(async (source: string, target: Target, how: How = "here", restore = false) => {
        if (!target.project_id || !active()) return;
        const from = entries.current.get(source);
        const baseId = from?.base ?? source;
        const id = projectLayoutKey(baseId, target.project_id);
        // 숨긴 프로젝트에서 늦게 완료된 생성은 그 프로젝트만 갱신하고 현재 화면을 빼앗지 않는다.
        if (!from || from.projectId !== target.project_id) select(baseId, target.project_id);
        const entry = loadProject(baseId, target.project_id);
        await entry.ready;
        const layout = await updateAt(id, (layout) => {
            if (restore && L.allTabs(layout).length > 0) return layout;
            if (how === "here" || baseId.endsWith("-narrow") || L.allTabs(layout).length === 0) return L.openResource(layout, target);
            return L.splitLeaf(layout, layout.focused_leaf, how === "right" ? "row" : "column", target);
        });
        if (layout) return { id, layout };
    }, [active, loadProject, select, updateAt]);
    const flush = useCallback(() => {
        for (const entry of entries.current.values()) void entry.store.flush();
        for (const entry of shared.current.values()) void entry.store.flush();
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
