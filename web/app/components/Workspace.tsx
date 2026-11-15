import { HintText } from "../design/HintText";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { LayoutPanel, LayoutHeader } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { Banner } from "@astryxdesign/core/Banner";
import { Center } from "@astryxdesign/core/Center";
import { workspaceStyles } from "./workspace.stylex";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ContextType, type SetStateAction } from "react";
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
import { LabelChips, LabelFilter, ProjectMenu, useLabels } from "./ProjectLabels";
import { filterProjects } from "../state/projectLabels";
import { RecentPanel } from "./RecentPanel";
import { SearchPanel } from "./SearchPanel";
import { SplitView } from "./SplitView";
import { Icon } from "./icons";
import { ActionMenu } from "./ui/Controls";
import { SidebarProject } from "./sidebar";
import { SidebarUsage } from "./sidebar/SidebarUsage";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { CreationEntry, CreationFocus } from "./create/CreationEntry";
import { currentProjectId, projectTarget } from "./create/creation";
import { NavigationContext } from "./navigation/NavigationContext";
import { requireServerAction, useServerBlockReason } from "./pwa/lifecycle";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { Button } from "../design/Button";
import { MobileDrawer, useMobilePanels } from "./MobilePanels";

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
    const [wideSidebar, setWideSidebar] = useState(true);
    const mobile = useMobilePanels(narrow);
    const sidebar = narrow ? mobile.panel === "left" : wideSidebar;
    const setSidebar = useCallback((value: SetStateAction<boolean>) => {
        if (narrow) mobile.setPanel((current) => (typeof value === "function" ? value(current === "left") : value) ? "left" : null);
        else setWideSidebar(value);
    }, [narrow, mobile.setPanel]);
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
    const projects = useQuery<Project[]>(`projects:${projectSort}`, () => api.get(`/projects?sort=${projectSort}`),
        { keepPreviousData: true, scope: "projects" });
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
        const cached = store.restoreLocal();
        if (cached) setLayouts((cur) => ({ ...cur, [key]: cached }));
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
        [updateAt, setSidebar],
    );
    const open: Opener = useCallback((t, how) => openAt(key, t, how), [key, openAt]);
    // OS 알림을 누르면 해당 대화를 현재 배치에 연다(SETTINGS-014).
    useEffect(() => onOpenSession((projectId, sessionId) => open({ kind: "session", project_id: projectId, resource_id: sessionId, title: "대화" })), [open]);

    const serverBlocked = useServerBlockReason();
    const [adding, setAdding] = useState<{ step: "choose"; projectId?: string } | { step: "project" } | null>(null);
    const creationTrigger = useRef<HTMLButtonElement | null>(null);
    const closeCreation = () => {
        setAdding(null);
        // 선택 창에서 프로젝트 추가 창으로 교체되어도 최초 진입 버튼으로 돌아간다.
        requestAnimationFrame(() => creationTrigger.current?.focus({ preventScroll: true }));
    };
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

    // 넓은 화면에서 사이드바가 열려 있으면 만들기는 사이드바 맨 위 메뉴에, 아니면 상단 바에 하나만 둔다.
    const createInSidebar = sidebar && !narrow;
    const create = (inSidebar: boolean) => (
        <Button variant="secondary" appearance={inSidebar ? "navigation" : "icon"} aria-haspopup="dialog" disabled={!layout}
            title={serverBlocked ?? "새 대화·프로젝트 만들기"}
            onClick={(event) => { creationTrigger.current = event.currentTarget; setAdding({ step: "choose", projectId: currentProjectId(layout) }); }}>
            <Icon name="edit" />{inSidebar ? <GroveText type="inherit" color="inherit">만들기</GroveText> : <VisuallyHidden>만들기</VisuallyHidden>}
        </Button>
    );
    const brand = (
        <Stack as="span" direction="horizontal" align="center" gap={1}>
            <GroveText type="inherit" color="brand" aria-hidden="true"><Icon name="sprout" size={20} /></GroveText>
            {!narrow && <GroveText weight="semibold">Grove</GroveText>}
        </Stack>
    );
    const selectedProjectId = currentProjectId(layout);
    const selectedProject = projects.data?.find((p) => p.id === selectedProjectId);
    const mobileTabs = layout ? L.allTabs(layout).filter((tab) => tab.project_id === selectedProjectId || !tab.project_id) : [];

    return (
        <CreationFocus.Provider value={creationFocus}>
        <Stack direction="horizontal" gap={0} height="100%" data-testid="workspace" data-viewport-mode={narrow ? "narrow" : "wide"}>
            <MobileDrawer enabled={narrow} side="left" open={mobile.panel === "left"} drag={mobile.drag}
                label="탐색 메뉴" onClose={() => mobile.setPanel(null)}>
            {(sidebar || narrow) && (
                <LayoutPanel width={narrow ? "100%" : 280} hasDivider={!narrow} padding={0} isScrollable={false}
                    role="complementary" label="탐색" data-testid="sidebar" xstyle={workspaceStyles.navigation}>
                    <Stack gap={0} height="100%">
                    {!narrow && <Stack direction="horizontal" align="center" gap={0} minHeight={40} paddingInline={4}>{brand}</Stack>}
                    <Stack gap={0} padding={2} data-testid="sidebar-navigation">
                        {createInSidebar && create(true)}
                        <SearchPanel open={open} />
                        {narrow && <Button variant="secondary" appearance="navigation" onClick={() => open({ kind: "settings", title: "설정" })}>
                            <Icon name="settings" /><GroveText type="inherit" color="inherit">설정</GroveText>
                        </Button>}
                    </Stack>
                    <StackItem size="fill">
                    <ScrollableArea axis="block" label="프로젝트·최근 목록" height="100%" data-testid="sidebar-scroll">
                    <Stack gap={1} paddingInline={2}>
                        <Stack as="section" gap={0} data-testid="projects">
                            <Stack direction="horizontal" align="center" justify="between" gap={0} minHeight={28} paddingInlineStart={2}>
                                <Heading level={2} type="navigation" color="secondary">프로젝트</Heading>
                                <ActionMenu label="프로젝트 목록 옵션"
                                    trigger={<>⋯{labelFilter.length > 0 && <StatusDot variant="accent" label="라벨 필터 적용 중" />}</>}>
                                    <Stack gap={1}>
                                <Select
                                    label="프로젝트 정렬" hideLabel
                                    value={projectSort}
                                    onChange={(value) => {
                                        const v = value === "recent" ? "recent" : "name";
                                        localStorage.setItem(PROJECT_SORT, v);
                                        setProjectSort(v);
                                    }}
                                    options={[{ value: "name", label: "이름순" }, { value: "recent", label: "최근 활동순" }]}
                                />
                                <Button type="button" variant="secondary" density="compact" aria-expanded={filtering} aria-label="라벨 필터"
                                    onClick={() => setFiltering((f) => !f)}>
                                    라벨{labelFilter.length > 0 ? ` (${labelFilter.length})` : ""}
                                </Button>
                                <Button type="button" variant="secondary" density="compact" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>보관됨</Button>
                                    </Stack>
                                </ActionMenu>
                            </Stack>
                            {filtering && <LabelFilter labels={labels} selected={labelFilter} onChange={setLabelFilter} />}
                            {showArchived && <ArchivedProjects />}
                            {shown.map((p) => (
                                <SidebarProject key={p.id} project={p} open={open} narrow={narrow} onCreate={() => startProject(p)}>
                                <Stack direction="horizontal" align="center" gap={0} minHeight={32} data-testid="project-row" data-project={p.name}>
                                    <Button appearance="navigation" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name })} title={p.root_path}>
                                        {p.pinned_at && <HintText aria-label="고정됨" hint="고정됨">📌</HintText>}
                                        {p.icon && <GroveText type="inherit" color="inherit" aria-hidden>{p.icon}</GroveText>} <GroveText type="inherit" color="inherit" maxLines={1}>{p.name}</GroveText> {!p.available && <GroveText type="supporting" color="warning">(경로 없음)</GroveText>}
                                        <LabelChips project={p} labels={labels} />
                                    </Button>
                                    <StackItem size="static"><Button type="button" variant="secondary" appearance="icon" width={32} aria-label="프로젝트 메뉴" title={`${p.name} 메뉴`} aria-expanded={menuFor === p.id}
                                        onClick={() => setMenuFor((m) => (m === p.id ? null : p.id))}>⋯</Button></StackItem>
                                    {menuFor === p.id && <ProjectMenu project={p} labels={labels} onClose={() => setMenuFor(null)}
                                        onSplit={narrow ? undefined : (how) => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name }, how)} />}
                                </Stack>
                                </SidebarProject>
                            ))}
                            {!!projects.data?.length && shown.length === 0 && (
                                <GroveText as="p" display="block" type="inherit" color="secondary" role="status">
                                    라벨 조건에 맞는 프로젝트가 없습니다. <Button type="button" variant="secondary" density="compact" onClick={() => setLabelFilter([])}>필터 해제</Button>
                                </GroveText>
                            )}
                        </Stack>
                        <RecentPanel open={open} linked={splitSessions} />
                    </Stack>
                    </ScrollableArea>
                    </StackItem>
                    <SidebarUsage />
                    </Stack>
                </LayoutPanel>
            )}
            </MobileDrawer>
            <StackItem size="fill"><Stack gap={0} height="100%" xstyle={workspaceStyles.main}>
            <LayoutHeader height={40} padding={0} hasDivider role="banner">
            <Stack direction="horizontal" align="center" height="100%" gap={narrow ? 1 : 2} paddingInline={narrow ? 2 : 4}>
                <Button variant="secondary" appearance="icon" aria-label="사이드바" title="사이드바" aria-expanded={sidebar} onClick={() => setSidebar((s) => !s)}>
                    <Icon name="sidebar" />
                </Button>
                {!createInSidebar && brand}
                {!createInSidebar && create(false)}
                {/* 현재 위치는 별도 줄 대신 상단 바 안에 둔다. */}
                <NavigationContext layout={layout} projects={projects.data ?? NO_PROJECTS} host={window.location.origin}
                    open={open} onBrowseProjects={() => setSidebar(true)} sidebarOpen={sidebar} />
                <ConnStatus status={status} retryAt={retryAt} onRetry={() => stream.current?.retryNow()} />
                {narrow ? <Button variant="secondary" appearance="icon" aria-label="열린 세션" title="열린 세션"
                    aria-expanded={mobile.panel === "right"} onClick={() => mobile.setPanel("right")}>
                    <Icon name="panel" />
                </Button> : <Button variant="secondary" appearance="icon" title="설정" onClick={() => open({ kind: "settings", title: "설정" })}>
                    <Icon name="settings" /><VisuallyHidden>설정</VisuallyHidden>
                </Button>}
            </Stack>
            </LayoutHeader>
            {adding?.step === "choose" && <CreationEntry projects={projects.data ?? NO_PROJECTS} currentId={adding.projectId}
                blockedReason={serverBlocked}
                loading={projects.loading} error={Boolean(projects.error)} onReload={projects.reload}
                onSelect={startProject} onAddProject={() => setAdding({ step: "project" })} onClose={closeCreation} />}
            {adding?.step === "project" && <AddProjectDialog blockedReason={serverBlocked} beforeMutation={requireServerAction} onDone={projectAdded} onClose={closeCreation} />}
            {notice && (
                <Banner status="warning" role="status" title={notice} endContent={<Stack direction="horizontal" gap={2}>
                    <ServerActionButton variant="secondary" onClick={() => { setNotice(null); for (const store of persistence.current.values()) void store.flush(); }}>배치 다시 저장</ServerActionButton>
                    <Button variant="secondary" onClick={() => setNotice(null)}>닫기</Button>
                </Stack>} />
            )}
            <StackItem size="fill">
                <Stack as="main" direction="horizontal" gap={0} height="100%">
                    {Object.entries(layouts).map(([id, saved]) => (
                        <SavedLayout key={id} id={id} layout={saved} onUpdate={updateAt} onOpen={openAt}
                            visible={id === key} projects={projects.data ?? NO_PROJECTS} />
                    ))}
                    {!layout && <Center padding={8}><GroveText type="supporting" color="secondary">배치 불러오는 중…</GroveText></Center>}
                </Stack>
            </StackItem>
            </Stack></StackItem>
            <MobileDrawer enabled={narrow} side="right" open={mobile.panel === "right"} drag={mobile.drag}
                label="열린 세션" onClose={() => mobile.setPanel(null)}>
                {narrow && <Stack as="nav" gap={1} padding={2} aria-label="현재 프로젝트 열린 탭">
                    {selectedProject && <Heading level={2} type="navigation">{selectedProject.name}</Heading>}
                    {(["session", "other"] as const).map((kind) => {
                        const tabs = mobileTabs.filter((tab) => kind === "session" ? tab.kind === "session" : tab.kind !== "session");
                        return tabs.length > 0 && <section key={kind} aria-label={kind === "session" ? "대화" : "다른 화면"}>
                            {kind === "other" && <Heading level={3} type="navigation">다른 화면</Heading>}
                            {tabs.map((tab) => <Stack direction="horizontal" align="center" gap={0} key={tab.id} data-testid="mobile-open-tab">
                                <Button type="button" appearance="navigation" aria-current={layout && L.focusedLeaf(layout).active_tab === tab.id ? "page" : undefined}
                                    onClick={() => { updateAt(key, (current) => L.activate(current, tab.id)); mobile.setPanel(null); }}>
                                    {tab.title}
                                </Button>
                                <Button type="button" variant="secondary" appearance="icon" aria-label={`${tab.title} 탭 닫기`}
                                    title="화면만 닫습니다. 실행과 초안은 유지됩니다."
                                    onClick={() => updateAt(key, (current) => L.closeTab(current, tab.id))}>×</Button>
                            </Stack>)}
                        </section>;
                    })}
                </Stack>}
            </MobileDrawer>
        </Stack>
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
        <HintText color={status === "offline" || status === "auth_expired" ? "error" : status === "live" ? "secondary" : "warning"} hint={`서버 연결 상태: ${label}`} data-testid="conn" role="status">
            <StatusDot variant={status === "offline" || status === "auth_expired" ? "error" : status === "live" ? "success" : "warning"} label={label} />
            <VisuallyHidden>{label}</VisuallyHidden>
            {status === "offline" && (
                <Button variant="secondary" density="compact" onClick={onRetry}>
                    지금 재연결
                </Button>
            )}
        </HintText>
    );
}
