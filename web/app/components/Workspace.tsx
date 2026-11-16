import { HintText } from "../design/HintText";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { LayoutPanel, LayoutHeader } from "@astryxdesign/core/Layout";
import { useResizable } from "@astryxdesign/core/Resizable";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { Popover } from "@astryxdesign/core/Popover";
import { Banner } from "@astryxdesign/core/Banner";
import { Center } from "@astryxdesign/core/Center";
import { workspaceStyles } from "./workspace.stylex";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { api } from "../api/client";
import { EventStream } from "../api/events";
import type { Project } from "../api/generated";
import { notifyAttention, onOpenSession } from "../state/attention";
import { applyPrefs, isNarrow, layoutKey, loadPrefs } from "../state/device";
import * as L from "../state/layout";
import { useProjectLayouts } from "../state/useProjectLayouts";
import { useProjectSplits } from "../state/useProjectSplits";
import { activeProjectSplits, placeProject, projectGeometry } from "../state/projectSplits";
import { projectLayoutKey } from "../state/projectLayout";
import { DRAG_PROJECT, PROJECT_ORDER, loadProjectOrder, moveProject, orderProjects, parseProjectDrag, type ProjectSort } from "../state/projectOrder";
import { applyEvent, resyncAll, setLive, useLive, useQuery } from "../state/store";
import { AddProjectDialog } from "./AddProject";
import { ArchivedProjects } from "./ArchivedProjects";
import { LabelChips, LabelFilter, ProjectMenu, useLabels } from "./ProjectLabels";
import { filterProjects } from "../state/projectLabels";
import { RecentPanel } from "./RecentPanel";
import { SplitView } from "./SplitView";
import { ProjectSplitDividers } from "./ProjectSplitDividers";
import { splitStyles } from "./split-layout.stylex";
import { Icon } from "./icons";
import { ActionMenu } from "./ui/Controls";
import { SidebarProject } from "./sidebar";
import { SidebarUsage } from "./sidebar/SidebarUsage";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { CreationEntry } from "./create/CreationEntry";
import { ProjectFolderDialog, ProjectFolderTree, useProjectFolders } from "./ProjectFolders";
import { projectTarget } from "./create/creation";
import { NavigationContext } from "./navigation/NavigationContext";
import { requireServerAction, useServerBlockReason } from "./pwa/lifecycle";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { Button } from "../design/Button";
import { MobileDrawer, useMobilePanels } from "./MobilePanels";
import { SettingsDialog } from "./SettingsDialog";

export type OpenTarget = Omit<L.Tab, "id">;
export type Opener = (t: OpenTarget, how?: "here" | "right" | "down") => void;

const PROJECT_SORT = "grove.projectSort";
const LABEL_FILTER = "grove.labelFilter";
const NO_PROJECTS: Project[] = [];

type LayoutActions = {
    onUpdate: (id: string, f: (layout: L.Layout) => L.Layout) => void;
    onOpen: (id: string, target: OpenTarget, how?: "here" | "right" | "down") => void;
    onProjectDrop: (id: string, target: OpenTarget, edge: L.DropEdge) => void;
    onCloseProject?: (id: string) => void;
};
const SavedLayout = memo(function SavedLayout({ id, layout, visible, projects, projectLabel, onUpdate, onOpen, onProjectDrop, onCloseProject }: LayoutActions & {
    id: string; layout: L.Layout; visible: boolean; projects: Project[]; projectLabel?: string;
}) {
    const update = useCallback((f: (layout: L.Layout) => L.Layout) => onUpdate(id, f), [id, onUpdate]);
    const open: Opener = useCallback((target, how) => onOpen(id, target, how), [id, onOpen]);
    const drop = useCallback((target: OpenTarget, edge: L.DropEdge) => onProjectDrop(id, target, edge), [id, onProjectDrop]);
    const close = useCallback(() => onCloseProject?.(id), [id, onCloseProject]);
    return <SplitView layout={layout} update={update} open={open} narrow={id.endsWith("-narrow")} visible={visible} projects={projects}
        projectLabel={projectLabel} onProjectDrop={drop} onCloseProject={onCloseProject ? close : undefined} />;
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
    const [settingsTarget, setSettingsTarget] = useState<OpenTarget | null>(null);
    const status = useLive((live) => live.status);
    const retryAt = useLive((live) => live.retryAt);
    const [wideSidebar, setWideSidebar] = useState(true);
    const sidebarToggle = useRef<HTMLButtonElement | null>(null);
    const focusSidebarToggle = useRef(false);
    useLayoutEffect(() => {
        if (!focusSidebarToggle.current) return;
        focusSidebarToggle.current = false;
        sidebarToggle.current?.focus({ preventScroll: true });
    }, [wideSidebar]);
    const navigation = useResizable({
        defaultSize: 280, minSize: 280, maxSize: 280, collapsible: true,
        isCollapsed: !narrow && !wideSidebar,
        onCollapseChange: (collapsed) => setWideSidebar(!collapsed),
    });
    const mobile = useMobilePanels(narrow);
    const sidebar = narrow ? mobile.panel === "left" : wideSidebar;
    const setSidebar = useCallback((value: SetStateAction<boolean>) => {
        if (narrow) mobile.setPanel((current) => (typeof value === "function" ? value(current === "left") : value) ? "left" : null);
        else setWideSidebar(value);
    }, [narrow, mobile.setPanel]);
    const [notice, setNotice] = useState<string | null>(null);
    const baseKey = useMemo(() => layoutKey(), [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
    const { key, projectId: selectedProjectId, layout, layouts, updateAt, openAt: openProjectAt, flush, focusAt, projectAt, ensureProject } = useProjectLayouts(baseKey, setNotice);
    const projectSplits = useProjectSplits(baseKey, selectedProjectId, setNotice);
    const projectGroup = useMemo(() => narrow ? activeProjectSplits(null, selectedProjectId) : projectSplits.layout,
        [narrow, selectedProjectId, projectSplits.layout]);
    const geometry = useMemo(() => projectGeometry(projectGroup), [projectGroup]);
    const placements = useMemo(() => new Map(geometry.panes.length
        ? geometry.panes.map(({ projectId, rect }) => [projectLayoutKey(baseKey, projectId), rect] as const)
        : [[baseKey, { x: 0, y: 0, width: 1, height: 1 }]]), [baseKey, geometry]);
    const projectContainer = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        for (const pane of geometry.panes) ensureProject(baseKey, pane.projectId);
    }, [baseKey, geometry, ensureProject]);
    // 현재 배치의 각 영역에 보이는 대화가 둘 이상이면 최근 목록에서 한 묶음으로 보여 준다(원본 최근 탭).
    const splitSessions = useMemo(() => {
        const ids = new Set([...placements.keys()].flatMap((id) => layouts[id] ? L.leaves(layouts[id].root) : [])
            .filter((leaf) => !narrow || leaf.id === layout?.focused_leaf).map((leaf) => leaf.tabs.find((t) => t.id === leaf.active_tab))
            .filter((t): t is L.Tab => t?.kind === "session" && !!t.resource_id).map((t) => t.resource_id!));
        return ids.size > 1 ? ids : new Set<string>();
    }, [layout, layouts, placements, narrow]);
    // 프로젝트 목록 정렬은 기기별 선택(PROJECT-002): 이름순 또는 최근 활동순.
    const [projectSort, setProjectSort] = useState<ProjectSort>(() => {
        const value = localStorage.getItem(PROJECT_SORT);
        return value === "manual" || value === "recent" ? value : "name";
    });
    const [projectOrder, setProjectOrder] = useState(() => loadProjectOrder(localStorage));
    const draggingProject = useRef<string | null>(null);
    const [orderDrop, setOrderDrop] = useState<{ id: string; after: boolean } | null>(null);
    const projects = useQuery<Project[]>(`projects:${projectSort}`, () => api.get(`/projects?sort=${projectSort === "recent" ? "recent" : "name"}`),
        { keepPreviousData: true, scope: "projects" });
    // 라벨 필터는 기기별 선택(PROJECT-008). 삭제된 라벨 id는 필터에서 무시한다.
    const labels = useLabels();
    const folders = useProjectFolders();
    const [labelFilter, setLabelFilterState] = useState<string[]>(() => {
        try { const v = JSON.parse(localStorage.getItem(LABEL_FILTER) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
    });
    const setLabelFilter = (next: string[]) => { localStorage.setItem(LABEL_FILTER, JSON.stringify(next)); setLabelFilterState(next); };
    const [filtering, setFiltering] = useState(labelFilter.length > 0);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const shown = filterProjects(projectSort === "manual" ? orderProjects(projects.data ?? NO_PROJECTS, projectOrder) : projects.data ?? NO_PROJECTS, labelFilter, labels);
    const reorder = (sourceId: string, targetId: string, after: boolean) => {
        const all = projects.data ?? NO_PROJECTS;
        const source = all.find((p) => p.id === sourceId), target = all.find((p) => p.id === targetId);
        if (!source || !target || sourceId === targetId || (source.folder_id ?? null) !== (target.folder_id ?? null)) return;
        const next = moveProject(all, projectSort === "manual" ? projectOrder : [], sourceId, targetId, after);
        setProjectOrder(next);
        setProjectSort("manual");
        try {
            localStorage.setItem(PROJECT_ORDER, JSON.stringify(next));
            localStorage.setItem(PROJECT_SORT, "manual");
        } catch { setNotice("이 기기에 프로젝트 순서를 보존하지 못했습니다. 저장 공간을 확인하세요."); }
    };

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

    const openAt = useCallback(
        (id: string, t: OpenTarget, how: "here" | "right" | "down" = "here") => {
            const small = id.endsWith("-narrow");
            if (t.kind === "settings") {
                setSettingsTarget(t);
                if (small) setSidebar(false);
                return;
            }
            openProjectAt(id, t, how);
            if (small) setSidebar(false);
        },
        [openProjectAt, setSidebar],
    );
    const open: Opener = useCallback((t, how) => openAt(baseKey, t, how), [baseKey, openAt]);
    const dropProject = useCallback((source: string, target: OpenTarget, edge: L.DropEdge) => {
        if (!projects.data?.some((project) => project.id === target.project_id)) return;
        const sourceId = projectAt(source) ?? selectedProjectId;
        if (!narrow && sourceId) {
            const next = placeProject(projectGroup, sourceId, target, edge);
            if (next === projectGroup) return;
            projectSplits.update(() => next);
        }
        openProjectAt(baseKey, target, "here", true);
    }, [baseKey, narrow, openProjectAt, projectAt, projectGroup, projectSplits.update, projects.data, selectedProjectId]);
    const closeProject = useCallback((id: string) => {
        const leaf = L.leaves(projectGroup.root).find((item) => item.tabs[0]?.project_id === projectAt(id));
        if (!leaf || geometry.panes.length < 2) return;
        const next = L.closeTab(projectGroup, leaf.tabs[0]!.id);
        projectSplits.update(() => next);
        const remaining = L.focusedLeaf(next).tabs[0]?.project_id;
        if (remaining) focusAt(projectLayoutKey(baseKey, remaining));
    }, [baseKey, focusAt, geometry.panes.length, projectAt, projectGroup, projectSplits.update]);
    // OS 알림을 누르면 해당 대화를 현재 배치에 연다(SETTINGS-014).
    useEffect(() => onOpenSession((projectId, sessionId) => open({ kind: "session", project_id: projectId, resource_id: sessionId, title: "대화" })), [open]);

    const serverBlocked = useServerBlockReason();
    const [adding, setAdding] = useState<"project" | "folder" | null>(null);
    const creationTrigger = useRef<HTMLButtonElement | null>(null);
    const closeCreation = () => {
        setAdding(null);
        // 추가 메뉴에서 연 창을 닫으면 최초 + 버튼으로 돌아간다.
        requestAnimationFrame(() => creationTrigger.current?.focus({ preventScroll: true }));
    };
    const projectAdded = (p: Project) => {
        setAdding(null);
        projects.reload();
        open(projectTarget(p));
    };

    // 전역 +는 펼친 탐색 패널에만 둔다. 모바일에서도 대화 생성과 섞지 않는다.
    const create = () => (
        <CreationEntry foldersSupported={folders.supported !== false}
            onTrigger={(button) => { creationTrigger.current = button; }}
            onAddProject={() => setAdding("project")} onAddFolder={() => setAdding("folder")} />
    );
    const brand = (
        <Stack as="span" direction="horizontal" align="center" gap={1}>
            <GroveText type="inherit" color="brand" aria-hidden="true"><Icon name="sprout" size={20} /></GroveText>
            {!narrow && wideSidebar && <GroveText weight="semibold">Grove</GroveText>}
        </Stack>
    );
    const sidebarControl = (
        <Button ref={sidebarToggle} variant="secondary" appearance="icon" aria-label="사이드바"
            title={sidebar ? "사이드바 접기" : "사이드바 펼치기"} aria-expanded={sidebar}
            onClick={(event) => {
                if (narrow) event.currentTarget.focus({ preventScroll: true });
                else focusSidebarToggle.current = true;
                setSidebar((s) => !s);
            }}>
            <Icon name="sidebar" />
        </Button>
    );
    const settingsControl = (
        <Button variant="secondary" appearance="icon" title="설정" onClick={() => open({ kind: "settings", title: "설정" })}>
            <Icon name="settings" /><VisuallyHidden>설정</VisuallyHidden>
        </Button>
    );
    const selectedProject = projects.data?.find((p) => p.id === selectedProjectId);
    const mobileTabs = layout ? L.allTabs(layout).filter((tab) => tab.project_id === selectedProjectId || !tab.project_id) : [];
    const renderProject = (p: Project) => (
        <SidebarProject key={p.id} project={p} open={open} narrow={narrow}>
            <Stack direction="horizontal" align="center" gap={0} minHeight={32} data-testid="project-row" data-project={p.name}
                data-order-drop={orderDrop?.id === p.id ? orderDrop.after ? "after" : "before" : undefined}
                xstyle={workspaceStyles.projectRow}
                onDragOver={(event) => {
                    const source = projects.data?.find((item) => item.id === draggingProject.current);
                    if (!event.dataTransfer.types.includes(DRAG_PROJECT) || !source || source.id === p.id
                        || (source.folder_id ?? null) !== (p.folder_id ?? null)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const box = event.currentTarget.getBoundingClientRect();
                    setOrderDrop({ id: p.id, after: event.clientY > box.top + box.height / 2 });
                }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOrderDrop(null); }}
                onDrop={(event) => {
                    const target = parseProjectDrag(event.dataTransfer.getData(DRAG_PROJECT));
                    if (!target?.project_id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    reorder(target.project_id, p.id, event.clientY > box.top + box.height / 2);
                    setOrderDrop(null);
                }}>
                <Button appearance="navigation" aria-current={selectedProjectId === p.id ? "page" : undefined}
                    draggable onDragStart={(event) => {
                        draggingProject.current = p.id;
                        event.dataTransfer.setData(DRAG_PROJECT, JSON.stringify(projectTarget(p)));
                        event.dataTransfer.effectAllowed = "copyMove";
                    }}
                    onDragEnd={() => { draggingProject.current = null; setOrderDrop(null); }}
                    onKeyDown={(event) => {
                        if (!event.altKey || !event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                        event.preventDefault();
                        const siblings = shown.filter((item) => (item.folder_id ?? null) === (p.folder_id ?? null));
                        const next = siblings[siblings.findIndex((item) => item.id === p.id) + (event.key === "ArrowUp" ? -1 : 1)];
                        if (next) reorder(p.id, next.id, event.key === "ArrowDown");
                    }}
                    onClick={() => { openProjectAt(baseKey, projectTarget(p), "here", true); if (narrow) setSidebar(false); }}
                    title={`${p.root_path} · 끌어서 순서 변경 또는 프로젝트 분할(Alt+Shift+↑/↓ 순서 변경)`}>
                    {p.pinned_at && <HintText aria-label="고정됨" hint="고정됨">📌</HintText>}
                    {p.icon && <GroveText type="inherit" color="inherit" aria-hidden>{p.icon}</GroveText>} <GroveText type="inherit" color="inherit" maxLines={1}>{p.name}</GroveText> {!p.available && <GroveText type="supporting" color="warning">(경로 없음)</GroveText>}
                    <LabelChips project={p} labels={labels} />
                </Button>
                <StackItem size="static">
                    <Popover label={`${p.name} 메뉴`} isOpen={menuFor === p.id}
                        onOpenChange={(value) => setMenuFor(value ? p.id : null)}
                        placement="below" alignment="end" width={240} padding={2} isModal={false} hasCloseButton={false}
                        content={menuFor === p.id ? <ProjectMenu project={p} labels={labels} folders={folders.data} onClose={() => setMenuFor(null)}
                            onSplit={narrow ? undefined : (how) => p.id === selectedProjectId
                                ? open(projectTarget(p), how) : dropProject(key, projectTarget(p), how === "right" ? "right" : "bottom")} /> : null}>
                        <Button type="button" variant="secondary" appearance="icon" width={32}
                            aria-label="프로젝트 메뉴" title={`${p.name} 메뉴`}>⋯</Button>
                    </Popover>
                </StackItem>
            </Stack>
        </SidebarProject>
    );

    return (
        <Stack direction="horizontal" gap={0} height="100%" data-testid="workspace" data-viewport-mode={narrow ? "narrow" : "wide"}>
            {!narrow && !wideSidebar && <LayoutPanel width={48} padding={0} isScrollable={false}
                role="navigation" label="빠른 탐색" data-testid="sidebar-rail" xstyle={[workspaceStyles.navigation, workspaceStyles.rail]}>
                <Stack align="center" gap={0} height="100%">
                    <Stack align="center" justify="center" minHeight={40}>{sidebarControl}</Stack>
                    <StackItem size="fill" />
                    <Stack align="center" paddingBlock={2}>{settingsControl}</Stack>
                </Stack>
            </LayoutPanel>}
            <MobileDrawer enabled={narrow} side="left" open={mobile.panel === "left"} drag={mobile.drag}
                label="탐색 메뉴" onClose={() => mobile.setPanel(null)}>
                <LayoutPanel width={narrow ? "100%" : undefined} resizable={narrow ? undefined : navigation}
                    hasDivider={!narrow} padding={0} isScrollable={false}
                    role="complementary" label="탐색" data-testid="sidebar" xstyle={workspaceStyles.navigation}>
                    <Stack gap={0} height="100%">
                    {!narrow && <Stack direction="horizontal" align="center" justify="between" gap={0} minHeight={40} paddingInline={4}>
                        {brand}{wideSidebar && <Stack direction="horizontal" align="center" gap={0}>
                            {create()}{sidebarControl}
                        </Stack>}
                    </Stack>}
                    {narrow && <Stack gap={0} padding={2} data-testid="sidebar-navigation">
                        {create()}
                        <Button variant="secondary" appearance="navigation" onClick={() => open({ kind: "settings", title: "설정" })}>
                            <Icon name="settings" /><GroveText type="inherit" color="inherit">설정</GroveText>
                        </Button>
                    </Stack>}
                    <StackItem size="fill" xstyle={workspaceStyles.projects}>
                    <ScrollableArea axis="block" label="프로젝트 목록" height="100%" data-testid="sidebar-scroll">
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
                                        const v = value === "manual" || value === "recent" ? value : "name";
                                        localStorage.setItem(PROJECT_SORT, v);
                                        setProjectSort(v);
                                    }}
                                    options={[{ value: "name", label: "이름순" }, { value: "recent", label: "최근 활동순" }, { value: "manual", label: "직접 정렬" }]}
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
                            {Boolean(folders.error) && <GroveText type="supporting" color="error" role="alert">폴더를 불러오지 못했어요. <Button type="button" appearance="link" onClick={folders.reload}>다시 확인</Button></GroveText>}
                            <ProjectFolderTree projects={shown} folders={folders.data ?? []} renderProject={renderProject} />
                            {!!projects.data?.length && shown.length === 0 && (
                                <GroveText as="p" display="block" type="inherit" color="secondary" role="status">
                                    라벨 조건에 맞는 프로젝트가 없습니다. <Button type="button" variant="secondary" density="compact" onClick={() => setLabelFilter([])}>필터 해제</Button>
                                </GroveText>
                            )}
                        </Stack>
                    </Stack>
                    </ScrollableArea>
                    </StackItem>
                    <Stack gap={0} paddingInline={2} xstyle={workspaceStyles.recentDock}>
                        <SidebarUsage />
                        <RecentPanel open={open} linked={splitSessions} />
                    </Stack>
                    </Stack>
                </LayoutPanel>
            </MobileDrawer>
            <StackItem size="fill"><Stack gap={0} height="100%" xstyle={workspaceStyles.main}>
            <LayoutHeader height={40} padding={0} hasDivider role="banner">
            <Stack direction="horizontal" align="center" height="100%" gap={narrow ? 1 : 2} paddingInline={narrow ? 2 : 4}>
                {narrow && sidebarControl}
                {(narrow || !wideSidebar) && brand}
                {/* 현재 위치는 별도 줄 대신 상단 바 안에 둔다. */}
                <NavigationContext layout={layout} projects={projects.data ?? NO_PROJECTS}
                    open={open} onBrowseProjects={() => setSidebar(true)} sidebarOpen={sidebar} />
                <ConnStatus status={status} retryAt={retryAt} onRetry={() => stream.current?.retryNow()} />
                {narrow ? <Button variant="secondary" appearance="icon" aria-label="열린 세션" title="열린 세션"
                    aria-expanded={mobile.panel === "right"} onClick={() => mobile.setPanel("right")}>
                    <Icon name="panel" />
                </Button> : wideSidebar && settingsControl}
            </Stack>
            </LayoutHeader>
            {settingsTarget && <SettingsDialog key={`${settingsTarget.project_id ?? ""}:${settingsTarget.resource_id ?? ""}`}
                target={settingsTarget} projectName={projects.data?.find((p) => p.id === settingsTarget.project_id)?.name}
                open={open} onClose={() => setSettingsTarget(null)} />}
            {adding === "project" && <AddProjectDialog blockedReason={serverBlocked} beforeMutation={requireServerAction} onDone={projectAdded} onClose={closeCreation} />}
            {adding === "folder" && <ProjectFolderDialog onDone={() => { setAdding(null); folders.reload(); }} onClose={closeCreation} />}
            {notice && (
                <Banner status="warning" role="status" title={notice} endContent={<Stack direction="horizontal" gap={2}>
                    <ServerActionButton variant="secondary" onClick={() => { setNotice(null); flush(); }}>배치 다시 저장</ServerActionButton>
                    <Button variant="secondary" onClick={() => setNotice(null)}>닫기</Button>
                </Stack>} />
            )}
            <StackItem size="fill">
                <Stack as="main" ref={projectContainer} direction="horizontal" gap={0} height="100%" xstyle={splitStyles.projectRoot}>
                    {Object.entries(layouts).map(([id, saved]) => {
                        const rect = placements.get(id);
                        const projectId = projectAt(id);
                        const label = geometry.panes.length > 1 ? projects.data?.find((project) => project.id === projectId)?.name : undefined;
                        return <Stack key={id} direction="horizontal" gap={0} hidden={!rect} inert={!rect} data-project-pane={projectId}
                            data-project-focused={!!rect && projectId === selectedProjectId}
                            xstyle={splitStyles.projectPane(rect?.x ?? 0, rect?.y ?? 0, rect?.width ?? 1, rect?.height ?? 1)}
                            onPointerDownCapture={() => rect && projectId !== selectedProjectId && focusAt(id)}
                            onFocusCapture={() => rect && projectId !== selectedProjectId && focusAt(id)}>
                            <SavedLayout id={id} layout={saved} onUpdate={updateAt} onOpen={openAt} onProjectDrop={dropProject}
                                onCloseProject={geometry.panes.length > 1 ? closeProject : undefined} projectLabel={label}
                                visible={!!rect} projects={projects.data ?? NO_PROJECTS} />
                        </Stack>;
                    })}
                    {[...placements].filter(([id]) => !layouts[id]).map(([id, rect]) =>
                        <Center key={id} padding={8} xstyle={splitStyles.projectPane(rect.x, rect.y, rect.width, rect.height)}>
                            <GroveText type="supporting" color="secondary">배치 불러오는 중…</GroveText>
                        </Center>)}
                    {!narrow && <ProjectSplitDividers layout={projectGroup} container={projectContainer} update={projectSplits.update} />}
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
