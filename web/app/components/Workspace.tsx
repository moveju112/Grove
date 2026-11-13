import { memo, useCallback, useEffect, useMemo, useRef, useState, type ContextType } from "react";
import { api, authGeneration, isLoggedIn, newKey } from "../api/client";
import { EventStream } from "../api/events";
import type { Project } from "../api/generated";
import { notifyAttention, onOpenSession } from "../state/attention";
import { applyPrefs, isNarrow, layoutKey, loadPrefs } from "../state/device";
import * as L from "../state/layout";
import { LayoutPersistence } from "../state/layoutPersistence";
import { applyEvent, resyncAll, setLive, useLive, useQuery } from "../state/store";
import { AddProjectDialog } from "./AddProject";
import { ArchivedProjects } from "./ArchivedProjects";
import { BotsPanel } from "./BotsPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { LabelChips, LabelFilter, ProjectMenu, useLabels } from "./ProjectLabels";
import { filterProjects } from "../state/projectLabels";
import { RecentPanel } from "./RecentPanel";
import { RecoveryPanel } from "./RecoveryPanel";
import { SearchPanel } from "./SearchPanel";
import { SplitView } from "./SplitView";
import { Hosts } from "./Hosts";
import { SidebarProject } from "./sidebar";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { CreationEntry, CreationFocus } from "./create/CreationEntry";
import { currentProjectId, projectTarget } from "./create/creation";
import { NavigationContext } from "./navigation/NavigationContext";
import { requireServerAction, useServerBlockReason } from "./pwa/lifecycle";

export type OpenTarget = Omit<L.Tab, "id">;
export type Opener = (t: OpenTarget, how?: "here" | "right" | "down") => void;

const PROJECT_SORT = "grove.projectSort";
const LABEL_FILTER = "grove.labelFilter";
const NO_PROJECTS: Project[] = [];

type LayoutActions = {
    onUpdate: (id: string, f: (layout: L.Layout) => L.Layout) => void;
    onOpen: (id: string, target: OpenTarget, how?: "here" | "right" | "down") => void;
};
const SavedLayout = memo(function SavedLayout({ id, layout, visible, projects, onUpdate, onOpen }: LayoutActions & {
    id: string; layout: L.Layout; visible: boolean; projects: Project[];
}) {
    const update = useCallback((f: (layout: L.Layout) => L.Layout) => onUpdate(id, f), [id, onUpdate]);
    const open: Opener = useCallback((target, how) => onOpen(id, target, how), [id, onOpen]);
    return <SplitView layout={layout} update={update} open={open} narrow={id.endsWith("-narrow")} visible={visible} projects={projects} />;
});

function useNarrow(): boolean {
    const [n, setN] = useState(isNarrow());
    useEffect(() => {
        const m = window.matchMedia("(max-width: 760px)");
        const f = () => setN(m.matches);
        m.addEventListener("change", f);
        return () => m.removeEventListener("change", f);
    }, []);
    return n;
}

export function Workspace() {
    const narrow = useNarrow();
    const status = useLive((live) => live.status);
    const retryAt = useLive((live) => live.retryAt);
    const [layouts, setLayouts] = useState<Record<string, L.Layout>>({});
    const [sidebar, setSidebar] = useState(!isNarrow());
    const [notice, setNotice] = useState<string | null>(null);
    const persistence = useRef(new Map<string, LayoutPersistence>());
    const key = useMemo(() => layoutKey(), [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
    const layout = layouts[key];
    // 현재 배치의 각 영역에 보이는 대화가 둘 이상이면 최근 목록에서 한 묶음으로 보여 준다(원본 최근 탭).
    const splitSessions = useMemo(() => {
        const ids = new Set(layout ? L.leaves(layout.root).map((leaf) => leaf.tabs.find((t) => t.id === leaf.active_tab))
            .filter((t): t is L.Tab => t?.kind === "session" && !!t.resource_id).map((t) => t.resource_id!) : []);
        return ids.size > 1 ? ids : new Set<string>();
    }, [layout]);
    // 프로젝트 목록 정렬은 기기별 선택(PROJECT-002): 이름순 또는 최근 활동순.
    const [projectSort, setProjectSort] = useState<"name" | "recent">(() => (localStorage.getItem(PROJECT_SORT) === "recent" ? "recent" : "name"));
    const projects = useQuery<Project[]>(`projects:${projectSort}`, () => api.get(`/projects?sort=${projectSort}`));
    // 라벨 필터는 기기별 선택(PROJECT-008). 삭제된 라벨 id는 필터에서 무시한다.
    const labels = useLabels();
    const [labelFilter, setLabelFilterState] = useState<string[]>(() => {
        try { const v = JSON.parse(localStorage.getItem(LABEL_FILTER) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
    });
    const setLabelFilter = (next: string[]) => { localStorage.setItem(LABEL_FILTER, JSON.stringify(next)); setLabelFilterState(next); };
    const [filtering, setFiltering] = useState(labelFilter.length > 0);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const shown = filterProjects(projects.data ?? NO_PROJECTS, labelFilter, labels);

    useEffect(() => applyPrefs(loadPrefs()), []);

    // 이벤트 stream
    const stream = useRef<EventStream | null>(null);
    useEffect(() => {
        const s = new EventStream({
            onEvent: (e) => {
                applyEvent(e);
                notifyAttention(e);
            },
            onPartial: (sid, snap) => setLive((l) => ({ ...l, partials: { ...l.partials, [sid]: snap } })),
            onResync: () => resyncAll(),
            onStatus: (status, retryAt) => setLive((l) => ({ ...l, status, retryAt })),
        });
        stream.current = s;
        s.start(null);
        return () => s.stop();
    }, []);

    // 숨긴 배치도 확정 상태를 계속 받는다. 서버 작업의 수명은 화면 크기와 무관하다.
    useEffect(() => {
        const visible = Object.values(layouts).flatMap((l) => L.leaves(l.root))
            .map((leaf) => leaf.tabs.find((t) => t.id === leaf.active_tab))
            .filter((t): t is L.Tab => !!t && t.kind === "session" && !!t.resource_id)
            .map((t) => t.resource_id!);
        stream.current?.setSessions(visible);
    }, [layouts]);

    // 폭별 배치는 따로 복원하되 방문한 배치의 DOM·저장 수명은 로그아웃/unmount까지 보존한다.
    useEffect(() => {
        if (persistence.current.has(key)) return;
        const owner = authGeneration();
        const store = new LayoutPersistence(key, {
            store: localStorage, newKey, notice: setNotice,
            active: () => owner === authGeneration() && isLoggedIn(),
            get: (signal) => api.get(`/layouts/${key}`, { signal, timeoutMs: 10_000 }),
            put: ({ key: requestKey, ...body }, signal) => api.put(`/layouts/${key}`, body, { key: requestKey, signal, timeoutMs: 10_000 }),
        });
        persistence.current.set(key, store);
        void store.restore().then((restored) => { if (restored) setLayouts((cur) => ({ ...cur, [key]: restored })); });
    }, [key]);
    useEffect(() => {
        const stores = persistence.current;
        return () => { for (const store of stores.values()) store.dispose(); stores.clear(); };
    }, []);

    const updateAt = useCallback(
        (id: string, f: (l: L.Layout) => L.Layout) => {
            setLayouts((cur) => {
                const current = cur[id];
                if (!current) return cur;
                const next = f(current);
                if (next === current) return cur;
                persistence.current.get(id)?.change(next);
                return { ...cur, [id]: next };
            });
        },
        [],
    );

    const openAt = useCallback(
        (id: string, t: OpenTarget, how: "here" | "right" | "down" = "here") => {
            const small = id.endsWith("-narrow");
            updateAt(id, (l) => {
                const leaf = L.focusedLeaf(l);
                if (how === "here" || small) return L.openResource(l, t);
                return L.splitLeaf(l, leaf.id, how === "right" ? "row" : "column", t);
            });
            if (small) setSidebar(false);
        },
        [updateAt],
    );
    const open: Opener = useCallback((t, how) => openAt(key, t, how), [key, openAt]);
    // OS 알림을 누르면 해당 대화를 현재 배치에 연다(SETTINGS-014).
    useEffect(() => onOpenSession((projectId, sessionId) => open({ kind: "session", project_id: projectId, resource_id: sessionId, title: "대화" })), [open]);

    const serverBlocked = useServerBlockReason();
    const [adding, setAdding] = useState<{ step: "choose"; projectId?: string } | { step: "project" } | null>(null);
    const [creationFocus, setCreationFocus] = useState<ContextType<typeof CreationFocus>>(null);
    const startProject = (p: Project) => {
        if (!layout || !p.available) return;
        const target = projectTarget(p);
        const next = L.openResource(layout, target);
        const leaf = L.focusedLeaf(next);
        const tab = leaf.tabs.find((item) => item.id === leaf.active_tab);
        if (tab?.kind !== "project" || tab.project_id !== p.id) {
            setNotice("프로젝트 입력창을 열 수 없습니다. 사용하지 않는 탭을 닫고 다시 시도하세요.");
            return;
        }
        setAdding(null);
        updateAt(key, () => next);
        if (narrow) setSidebar(false);
        setCreationFocus((previous) => ({ tabId: tab.id, narrow, version: (previous?.version ?? 0) + 1 }));
    };
    const projectAdded = (p: Project) => {
        setAdding(null);
        projects.reload();
        startProject(p);
    };

    return (
        <CreationFocus.Provider value={creationFocus}>
        <div className={`ws ${narrow ? "narrow" : ""}`}>
            <header className="topbar">
                <button className="ghost icon" aria-label="사이드바" aria-expanded={sidebar} onClick={() => setSidebar((s) => !s)}>
                    ☰
                </button>
                <img src="/icon.svg" alt="" width={22} height={22} />
                <strong>Grove</strong>
                <Hosts />
                <ConnStatus status={status} retryAt={retryAt} onRetry={() => stream.current?.retryNow()} />
                <span className="spacer" />
                <button className="ghost" aria-haspopup="dialog" disabled={!layout}
                    title={serverBlocked ?? undefined}
                    onClick={() => setAdding({ step: "choose", projectId: currentProjectId(layout) })}>
                    만들기
                </button>
                <button className="ghost" onClick={() => open({ kind: "settings", title: "설정" })}>
                    설정
                </button>
            </header>
            {adding?.step === "choose" && <CreationEntry projects={projects.data ?? NO_PROJECTS} currentId={adding.projectId}
                blockedReason={serverBlocked}
                loading={projects.loading} error={Boolean(projects.error)} onReload={projects.reload}
                onSelect={startProject} onAddProject={() => setAdding({ step: "project" })} onClose={() => setAdding(null)} />}
            {adding?.step === "project" && <AddProjectDialog blockedReason={serverBlocked} beforeMutation={requireServerAction} onDone={projectAdded} onClose={() => setAdding(null)} />}
            {notice && (
                <div className="notice" role="status">
                    {notice} <ServerActionButton className="ghost" onClick={() => { setNotice(null); for (const store of persistence.current.values()) void store.flush(); }}>배치 다시 저장</ServerActionButton>
                    <button className="ghost" onClick={() => setNotice(null)}>닫기</button>
                </div>
            )}
            <NavigationContext layout={layout} projects={projects.data ?? NO_PROJECTS} host={window.location.origin}
                open={open} onBrowseProjects={() => setSidebar(true)} sidebarOpen={sidebar} />
            <div className="body">
                {sidebar && (
                    <aside className="sidebar">
                        <NotificationsPanel open={open} />
                        <RecoveryPanel open={open} />
                        <BotsPanel open={open} />
                        <SearchPanel open={open} />
                        <RecentPanel open={open} linked={splitSessions} />
                        <section className="projects">
                            <h2>
                                프로젝트{" "}
                                <select
                                    className="small"
                                    aria-label="프로젝트 정렬"
                                    value={projectSort}
                                    onChange={(e) => {
                                        const v = e.target.value === "recent" ? "recent" : "name";
                                        localStorage.setItem(PROJECT_SORT, v);
                                        setProjectSort(v);
                                    }}
                                >
                                    <option value="name">이름순</option>
                                    <option value="recent">최근 활동순</option>
                                </select>
                                <button type="button" className="ghost small" aria-expanded={filtering} aria-label="라벨 필터"
                                    onClick={() => setFiltering((f) => !f)}>
                                    라벨{labelFilter.length > 0 ? ` (${labelFilter.length})` : ""}
                                </button>
                            </h2>
                            {filtering && <LabelFilter labels={labels} selected={labelFilter} onChange={setLabelFilter} />}
                            <button type="button" className="ghost small" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>보관됨</button>
                            {showArchived && <ArchivedProjects />}
                            {shown.map((p) => (
                                <SidebarProject key={p.id} project={p} open={open} narrow={narrow} onCreate={() => startProject(p)}>
                                <div className="row" data-testid="project-row" data-project={p.name}>
                                    <button className="link" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name })} title={p.root_path}>
                                        {p.pinned_at && <span aria-label="고정됨" title="고정됨">📌</span>}
                                        {p.icon && <span className="project-icon" aria-hidden>{p.icon}</span>} {p.name} {!p.available && <em className="warn">(경로 없음)</em>}
                                        <LabelChips project={p} labels={labels} />
                                    </button>
                                    <button type="button" className="ghost small" aria-label="프로젝트 메뉴" title={`${p.name} 메뉴`} aria-expanded={menuFor === p.id}
                                        onClick={() => setMenuFor((m) => (m === p.id ? null : p.id))}>⋯</button>
                                    {menuFor === p.id && <ProjectMenu project={p} labels={labels} onClose={() => setMenuFor(null)} />}
                                    {!narrow && (
                                        <span className="row-actions">
                                            <button className="ghost small" title="오른쪽에 열기" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name }, "right")}>
                                                ⇥
                                            </button>
                                            <button className="ghost small" title="아래에 열기" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name }, "down")}>
                                                ⤓
                                            </button>
                                        </span>
                                    )}
                                </div>
                                </SidebarProject>
                            ))}
                            {projects.data?.length === 0 && <p className="muted">프로젝트를 추가하세요.</p>}
                            {!!projects.data?.length && shown.length === 0 && (
                                <p className="muted" role="status">
                                    라벨 조건에 맞는 프로젝트가 없습니다. <button type="button" className="ghost small" onClick={() => setLabelFilter([])}>필터 해제</button>
                                </p>
                            )}
                        </section>
                    </aside>
                )}
                <main className="main">
                    {Object.entries(layouts).map(([id, saved]) => (
                        <SavedLayout key={id} id={id} layout={saved} onUpdate={updateAt} onOpen={openAt}
                            visible={id === key} projects={projects.data ?? NO_PROJECTS} />
                    ))}
                    {!layout && <div className="boot">배치 불러오는 중…</div>}
                </main>
            </div>
        </div>
        </CreationFocus.Provider>
    );
}

/// 서버 연결 상태(UI-027). 끊기면 네트워크 문제인지 서버 문제인지와 다음 재시도까지 남은 시간을 보이고, 바로 재시도할 수 있다.
function ConnStatus({ status, retryAt, onRetry }: { status: string; retryAt?: number; onRetry: () => void }) {
    const [now, setNow] = useState(Date.now());
    const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(navigator.onLine);
        window.addEventListener("online", on);
        window.addEventListener("offline", on);
        return () => {
            window.removeEventListener("online", on);
            window.removeEventListener("offline", on);
        };
    }, []);
    useEffect(() => {
        if (status !== "offline") return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [status]);
    const left = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
    const label =
        status === "live"
            ? "연결됨"
            : status === "connecting"
              ? "연결 중"
              : status === "reconnecting"
                ? "재연결 중"
                : status === "auth_expired"
                  ? "로그인 만료"
                  : !online
                    ? "오프라인 · 네트워크 없음"
                    : `서버 연결 끊김 · ${left}초 후 재시도`;
    return (
        <span className={`conn ${status}`} title="서버 연결 상태" data-testid="conn" role="status">
            {label}
            {status === "offline" && (
                <button className="ghost small" onClick={onRetry}>
                    지금 재연결
                </button>
            )}
        </span>
    );
}
