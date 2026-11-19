import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, authGeneration, isLoggedIn, newKey } from "../api/client";
import * as L from "./layout";
import { LayoutPersistence, type RemoteLayout } from "./layoutPersistence";
import { projectLayout, projectLayoutKey } from "./projectLayout";
import { querySnapshot, subscribeQuery } from "./store";
import { applyWorkspaceTabs, mergeWorkspaceTabs, workspaceTabs, workspaceTabsKey } from "./workspaceTabs";
import { prefetchConversation, readWorkspaceResume, selectionKey } from "./workspaceStartup";
import { hasPendingInput } from "../components/pwa/pendingInput";

type Target = Omit<L.Tab, "id">;
type How = "here" | "right" | "down";
type Entry = { base: string; projectId: string; store: LayoutPersistence; ready: Promise<void>; hydrated: boolean };
type Shared = { store: LayoutPersistence; ready: Promise<L.Layout | null>; unsubscribe: () => void };

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
    const resumeProject = useRef<{ base: string; projectId: string; canApply: () => boolean } | null>(null);
    const userSelected = useRef(new Set<string>());
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
    const loadShared = useCallback((projectId: string, deviceLayout: Promise<L.Layout | null>): Shared => {
        const existing = shared.current.get(projectId);
        if (existing) return existing;
        const id = workspaceTabsKey(projectId);
        const query = `workspace-layout:${id}`;
        let initial: Promise<RemoteLayout> | undefined;
        const fetchLayout = () => api.get<RemoteLayout>(`/layouts/${id}`, { timeoutMs: 10_000 });
        let local: L.Layout | null = null;
        const store = makeStore(id, () => local ? workspaceTabs(local) : L.emptyLayout(), {
            get: () => initial ??= fetchLayout(),
            onRemote: (snapshot) => projectSnapshot(projectId, snapshot),
        });
        const ready = store.restore(deviceLayout.then((layout) => { local = layout; }));
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
        const migration = cached ? undefined : loadBase(baseId).then((layout) => { legacy = layout; });
        const deviceLayout = store.restore(migration);
        const sync = loadShared(projectId, deviceLayout);
        const ready = Promise.all([deviceLayout, sync.ready]).then(([restored]) => {
            if (!restored || !active()) return;
            const local = L.withoutSettingsTabs(restored);
            const snapshot = sync.store.snapshot();
            const candidate = resumeProject.current;
            const resume = (candidate?.base === baseId && candidate.projectId === projectId && candidate.canApply())
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
        if (stored && !/^[a-z0-9-]{1,64}$/i.test(stored)) stored = null;
        if (stored && active() && !userSelected.current.has(base)) {
            loadProject(base, stored);
            setSelected((cur) => base in cur ? cur : { ...cur, [base]: stored });
        }
        const controller = new AbortController();
        let interacted = false;
        const markInteraction = (event: Event) => { if (event.isTrusted) interacted = true; };
        const interactionEvents = ["pointerdown", "keydown", "input"];
        for (const type of interactionEvents) document.addEventListener(type, markInteraction, true);
        const canApply = () => !cancelled && active() && !userSelected.current.has(base) && !interacted && !hasPendingInput();
        const cleanUp = () => {
            for (const type of interactionEvents) document.removeEventListener(type, markInteraction, true);
            if (resumeProject.current?.canApply === canApply) resumeProject.current = null;
        };
        void (async () => {
            let remote: string | undefined;
            if (startupBase.current === base) {
                try {
                    const { layout } = await readWorkspaceResume(controller.signal);
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
            if (remote && canApply()) {
                resumeProject.current = { base, projectId: remote, canApply };
                const entry = loadProject(base, remote);
                if (!entry.hydrated) {
                    // 보이는 로컬 대화는 유지한다. 공유 배치가 실제로 준비될 때 입력·조작을 다시 확인한다.
                    await entry.ready;
                }
            }
            if (cancelled || !active()) return;
            const resume = remote && canApply() ? remote : undefined;
            if (resume) {
                // 서버 배치가 먼저 도착한 경우에도 공유 대화 선택을 한 번 반영한다.
                const id = projectLayoutKey(base, resume);
                const entry = entries.current.get(id);
                const current = layoutsRef.current[id];
                const snapshot = shared.current.get(resume)?.store.snapshot();
                if (entry?.hydrated && current && snapshot) {
                    const next = applyWorkspaceTabs(current, snapshot, true);
                    if (next !== current) { entry.store.change(next); publish(id, next); }
                }
            }
            setSelected((cur) => userSelected.current.has(base) || (base in cur && !resume)
                ? cur : { ...cur, [base]: resume ?? fallback });
        })().finally(cleanUp);
        return () => {
            cancelled = true;
            controller.abort();
            cleanUp();
        };
    }, [active, base, loadBase, loadProject, publish]);
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
        userSelected.current.add(baseId);
        if (resumeProject.current?.base === baseId) resumeProject.current = null;
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
        // 처음 여는 프로젝트의 배치 복원과 대상 대화 본문 조회를 병행한다. 탭이 열린 뒤 화면 구독이 이어받는다.
        const release = target.kind === "session" && target.resource_id && !entry.hydrated ? prefetchConversation(target.resource_id) : null;
        try { await entry.ready; }
        finally { if (release) setTimeout(release, 1000); }
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
