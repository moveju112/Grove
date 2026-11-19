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
import { ApiError, api, isTransportError } from "../api/client";
import { EventStream } from "../api/events";
import type { Project } from "../api/generated";
import { notifyAttention, onOpenSession } from "../state/attention";
import { applyPrefs, isNarrow, layoutKey, loadPrefs, usePrefs } from "../state/device";
import { applyTabShortcut } from "../state/shortcuts";
import { useWorkspaceShortcuts } from "./shortcuts/useWorkspaceShortcuts";
import * as L from "../state/layout";
import { useProjectLayouts } from "../state/useProjectLayouts";
import { useProjectSplits } from "../state/useProjectSplits";
import { activeProjectSplits, placeProject, projectGeometry } from "../state/projectSplits";
import { projectLayoutKey } from "../state/projectLayout";
import { readStoredLayout } from "../state/layoutPersistence";
import { DRAG_PROJECT, PROJECT_ORDER, PROJECT_SORT, loadProjectOrder, moveProject, orderProjects, parseProjectDrag, projectFolderDropAt, readProjectSort, type ProjectDrop, type ProjectSort } from "../state/projectOrder";
import { getWorkspaceProjects } from "../state/workspaceStartup";
import { applyEvent, batchEventQueries, queuePartial, resetStreamPartials, resyncAll, retryWaiting, setLive, useLive, useQuery } from "../state/store";
import { AddProjectDialog } from "./AddProject";
import { ArchivedProjects } from "./ArchivedProjects";
import { ProjectMenu } from "./ProjectMenu";
import { RecentPanel } from "./RecentPanel";
import { SplitView, type RecentPaneReveal } from "./SplitView";
import { ProjectSplitDividers } from "./ProjectSplitDividers";
import { PANE_REVEAL_DURATION, splitStyles } from "./split-layout.stylex";
import { Icon } from "./icons";
import { ActionMenu } from "./ui/Controls";
import { SidebarProject } from "./sidebar";
import { useTouchProjectOrder } from "./sidebar/useTouchProjectOrder";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { CreationEntry } from "./create/CreationEntry";
import { ProjectFolderDialog, ProjectFolderTree, useProjectFolders } from "./ProjectFolders";
import { requestNewConversation } from "../state/newConversation";
import { CreationRequest, projectTarget } from "./create/creation";
import { NavigationContext } from "./navigation/NavigationContext";
import { checkCompatibility, requireServerAction, useServerBlockReason } from "./pwa/lifecycle";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { Button } from "../design/Button";
import { MobileDrawer, useMobilePanels } from "./MobilePanels";
import { SettingsDialog } from "./SettingsDialog";
import { PushStatusContext, usePushSync } from "./PushNotifications";
import { ProjectHistoryDialog } from "./ProjectHistoryDialog";
import { ProjectRenameDialog } from "./ProjectRenameDialog";
import { ComposerMemoryProvider } from "../state/useComposerMemory";
import { hideSessionRecent } from "../state/recentPatch";
import { LoadingBar } from "./LoadingScreen";
import { UsagePanel } from "./UsagePanel";
import { dashboardStyles } from "./usage/dashboard.stylex";
import { CreationDialog } from "./create/CreationDialog";
import { useUsageNavigation } from "./usage/useUsageNavigation";
import { PaneVisibility } from "../state/paneVisibility";
import { HeaderUpdates } from "./update/HeaderUpdates";

export type OpenTarget = Omit<L.Tab, "id">;
export type Opener = (t: OpenTarget, how?: "here" | "right" | "down") => void;

const NO_PROJECTS: Project[] = [];

type LayoutActions = {
    onUpdate: (id: string, f: (layout: L.Layout) => L.Layout) => void;
    onCloseTab: (id: string, tabId: string) => void;
    closingTabs: ReadonlySet<string>;
    onOpen: (id: string, target: OpenTarget, how?: "here" | "right" | "down") => void;
    onProjectDrop: (id: string, target: OpenTarget, edge: L.DropEdge) => void;
    onCloseProject?: (id: string) => void;
    onNewTerminal: (id: string) => void;
};
const SavedLayout = memo(function SavedLayout({ id, layout, visible, projects, projectId, projectLabel, recentReveal, onUpdate, onCloseTab, closingTabs, onOpen, onProjectDrop, onCloseProject, onNewTerminal }: LayoutActions & {
    id: string; layout: L.Layout; visible: boolean; projects: Project[]; projectId?: string; projectLabel?: string; recentReveal?: RecentPaneReveal;
}) {
    const update = useCallback((f: (layout: L.Layout) => L.Layout) => onUpdate(id, f), [id, onUpdate]);
    const open: Opener = useCallback((target, how) => onOpen(id, target, how), [id, onOpen]);
    const drop = useCallback((target: OpenTarget, edge: L.DropEdge) => onProjectDrop(id, target, edge), [id, onProjectDrop]);
    const close = useCallback(() => onCloseProject?.(id), [id, onCloseProject]);
    const closeTab = useCallback((tabId: string) => onCloseTab(id, tabId), [id, onCloseTab]);
    const newTerminal = useCallback(() => onNewTerminal(id), [id, onNewTerminal]);
    return <ComposerMemoryProvider copies={L.allTabs(layout).map((tab) => tab.id)}>
        <SplitView layout={layout} update={update} closeTab={closeTab} closingTabs={closingTabs} open={open} narrow={id.endsWith("-narrow")} visible={visible} projects={projects}
            projectLabel={projectLabel} recentReveal={recentReveal} onProjectDrop={drop} onCloseProject={onCloseProject ? close : undefined}
            projectId={projectId} onNewTerminal={newTerminal} />
    </ComposerMemoryProvider>;
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
    const { usageOpen, usageVisited, openUsage, closeUsage, leaveUsage } = useUsageNavigation();
    const serverBlocked = useServerBlockReason();
    const { keyboardShortcuts, notifyPush, notifyVibrate } = usePrefs();
    const pushStatus = usePushSync(notifyPush, notifyVibrate, !!serverBlocked);
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
    const closing = useRef(new Set<string>());
    const [closingTabs, setClosingTabs] = useState<ReadonlySet<string>>(() => new Set());
    const [closeError, setCloseError] = useState<string | null>(null);
    const terminalPending = useRef(false);
    const [openingTerminal, setOpeningTerminal] = useState(false);
    const closeTab = useCallback((id: string, tabId: string) => {
        const current = layouts[id];
        if (!current) return;
        const tab = L.allTabs(current).find((item) => item.id === tabId);
        if (!tab || closing.current.has(tabId)) return;
        const session = tab.kind === "session" && tab.project_id && tab.resource_id
            && !L.allTabs(current).some((other) => other.id !== tabId && other.kind === "session" && other.resource_id === tab.resource_id);
        if ((!session && tab.kind !== "terminal") || !tab.resource_id) {
            updateAt(id, (current) => L.closeTab(current, tabId));
            return;
        }
        closing.current.add(tabId);
        setClosingTabs(new Set(closing.current));
        setCloseError(null);
        void (async () => {
            try {
                if (session) {
                    await hideSessionRecent(tab.project_id!, tab.resource_id!);
                } else {
                    try {
                        const result = await api.post<{ status: string }>(`/terminals/${tab.resource_id}/kill`);
                        if (result.status === "running") throw new Error("터미널 종료를 확인하지 못했어요. 탭을 다시 닫아 주세요.");
                    } catch (error) {
                        // 이미 삭제된 터미널은 종료할 프로세스가 없으므로 탭만 제거한다.
                        if (!(error instanceof ApiError && error.status === 404)) throw error;
                    }
                }
                updateAt(id, (current) => L.closeTab(current, tabId));
            } catch (error) {
                setCloseError(error instanceof ApiError ? error.message : session
                    ? "최근 목록에서 대화를 닫지 못했어요. 탭을 다시 닫아 주세요."
                    : "터미널 종료를 확인하지 못했어요. 탭을 다시 닫아 주세요.");
            } finally {
                closing.current.delete(tabId);
                setClosingTabs(new Set(closing.current));
            }
        })();
    }, [layouts, updateAt]);
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
    // 프로젝트 목록 정렬은 기기별 선택(PROJECT-002): 이름순 또는 최근 활동순.
    const [projectSort, setProjectSort] = useState<ProjectSort>(() => readProjectSort(localStorage));
    const [projectOrder, setProjectOrder] = useState(() => loadProjectOrder(localStorage));
    const [draggingProject, setDraggingProject] = useState<string | null>(null);
    const [desktopDrop, setDesktopDrop] = useState<ProjectDrop | null>(null);
    const projects = useQuery<Project[]>(`projects:${projectSort}`, () => getWorkspaceProjects(projectSort),
        { keepPreviousData: true, scope: "projects" });
    const splitGroups = useMemo(() => {
        if (narrow) return [];
        const keys = new Set((projects.data ?? NO_PROJECTS).map((project) => projectLayoutKey(baseKey, project.id)));
        const together = projectSplits.splitProjects.map((id) => projectLayoutKey(baseKey, id)).filter((id) => keys.has(id));
        const panes = (id: string) => {
            // 새로고침 후 열지 않은 프로젝트도 검증된 기기 사본으로 읽는다. 조회 때문에 배치를 열거나 편집하지 않는다.
            const saved = layouts[id] ?? readStoredLayout(localStorage, id);
            return saved ? L.leaves(saved.root).map((leaf) => new Set(leaf.tabs.flatMap((tab) =>
                tab.kind === "session" && tab.resource_id ? [tab.resource_id] : []))) : [];
        };
        for (const id of together) keys.delete(id);
        return [together.flatMap(panes), ...[...keys].map(panes)].filter((group) => group.length >= 2);
    }, [baseKey, layouts, narrow, projectSplits.splitProjects, projects.data]);
    const folders = useProjectFolders();
    const [folderMoveRequest] = useState(() => new CreationRequest<Project, `/projects/${string}`>("patch"));
    const [folderMoveBusy, setFolderMoveBusy] = useState(false);
    const [folderMoveError, setFolderMoveError] = useState<string | null>(null);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [historyProject, setHistoryProject] = useState<Project | null>(null);
    const [renamingProject, setRenamingProject] = useState<Project | null>(null);
    const projectMenuTrigger = useRef<HTMLButtonElement | null>(null);
    const closeHistory = () => {
        setHistoryProject(null);
        requestAnimationFrame(() => projectMenuTrigger.current?.focus({ preventScroll: true }));
    };
    const closeRename = () => {
        setRenamingProject(null);
        requestAnimationFrame(() => projectMenuTrigger.current?.focus({ preventScroll: true }));
    };
    const [showArchived, setShowArchived] = useState(false);
    const shown = projectSort === "manual" ? orderProjects(projects.data ?? NO_PROJECTS, projectOrder) : projects.data ?? NO_PROJECTS;
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
    const saveFolderMove = async (path: `/projects/${string}`, body: Record<string, unknown>) => {
        if (folderMoveRequest.busy) return;
        setFolderMoveBusy(true);
        setFolderMoveError(null);
        try {
            requireServerAction();
            await folderMoveRequest.run(path, body);
        } catch (error) {
            if (folderMoveRequest.pending) setFolderMoveError("프로젝트 이동 결과를 확인하지 못했어요.");
            else if (!isTransportError(error)) setFolderMoveError(error instanceof Error ? error.message : "프로젝트를 옮기지 못했어요.");
        } finally {
            projects.reload();
            folders.reload();
            setFolderMoveBusy(false);
        }
    };
    const canMoveToFolder = (sourceId: string, folderId: string | null) => {
        if (serverBlocked || folders.supported === false || folderMoveRequest.busy || folderMoveRequest.pending) return false;
        const source = shown.find((p) => p.id === sourceId);
        return !!source && (source.folder_id ?? null) !== folderId
            && (folderId === null || !!folders.data?.some((folder) => folder.id === folderId));
    };
    const applySidebarDrop = (sourceId: string, target: ProjectDrop) => {
        if (target.kind === "order") { reorder(sourceId, target.id, target.after); return; }
        const source = shown.find((p) => p.id === sourceId);
        if (source && canMoveToFolder(sourceId, target.folderId)) {
            void saveFolderMove(`/projects/${source.id}`, { expected_revision: source.revision, folder_id: target.folderId });
        }
    };
    const touchOrder = useTouchProjectOrder(narrow && sidebar, shown, canMoveToFolder, applySidebarDrop);
    const drop = narrow ? touchOrder?.target : desktopDrop;
    const projectDrop = drop?.kind === "order" ? drop : null;
    const dropFolderId = drop?.kind === "folder" ? drop.folderId : undefined;
    const draggedId = narrow ? touchOrder?.id : draggingProject;
    const showUnfiledDrop = !!draggedId && canMoveToFolder(draggedId, null);
    const pendingFolderMove = folderMoveRequest.pending;

    useEffect(() => applyPrefs(loadPrefs()), []);

    // 이벤트 stream
    const stream = useRef<EventStream | null>(null);
    useEffect(() => {
        const s = new EventStream({
            onEvents: (events) => batchEventQueries(() => {
                for (const event of events) {
                    applyEvent(event);
                    notifyAttention(event);
                }
            }),
            onPartial: queuePartial,
            onResync: (kind) => {
                if (kind === "subscription") { resetStreamPartials(); retryWaiting(); }
                else resyncAll(kind !== "reset");
            },
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

    const openRequest = useRef(0);
    const [recentReveal, setRecentReveal] = useState<(RecentPaneReveal & { layoutId: string }) | null>(null);
    useEffect(() => {
        if (!recentReveal) return;
        const timeout = window.setTimeout(() => setRecentReveal(null), PANE_REVEAL_DURATION);
        return () => window.clearTimeout(timeout);
    }, [recentReveal]);
    const openAt = useCallback(
        (id: string, t: OpenTarget, how: "here" | "right" | "down" = "here", fromRecent = false) => {
            const request = ++openRequest.current;
            setRecentReveal(null);
            const small = id.endsWith("-narrow");
            if (t.kind === "settings") {
                setSettingsTarget(t);
                if (small) setSidebar(false);
                return;
            }
            leaveUsage();
            const opened = openProjectAt(id, t, how);
            if (fromRecent && !small && t.kind === "session" && how === "here") {
                void opened.then((result) => {
                    if (!result || request !== openRequest.current) return;
                    // 세션 ID 대신 실제로 활성화된 탭 사본을 가리킨다.
                    const leaf = L.focusedLeaf(result.layout);
                    const tab = leaf.tabs.find((item) => item.id === leaf.active_tab);
                    if (tab?.kind === "session" && tab.project_id === t.project_id && tab.resource_id === t.resource_id) {
                        setRecentReveal({ layoutId: result.id, leafId: leaf.id, tabId: tab.id, request });
                    }
                });
            }
            // 최근 패널은 클릭한 완료 ID와 함께 자체적으로 접근을 기록한다.
            if (!fromRecent && t.kind === "session" && t.project_id && t.resource_id && !serverBlocked) {
                void api.post("/recent/touch", { kind: "session", project_id: t.project_id, resource_id: t.resource_id })
                    .catch((error) => {
                        if (isTransportError(error, true)) void checkCompatibility();
                        else setCloseError(error instanceof ApiError ? error.message : "최근 목록을 갱신하지 못했어요.");
                    });
            }
            if (small) setSidebar(false);
        },
        [openProjectAt, serverBlocked, setSidebar, leaveUsage],
    );
    const open: Opener = useCallback((t, how) => openAt(baseKey, t, how), [baseKey, openAt]);
    const openRecent: Opener = useCallback((t, how) => openAt(baseKey, t, how, true), [baseKey, openAt]);
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
        <Button variant="secondary" appearance="icon" aria-label="설정" title="설정" onClick={() => open({ kind: "settings", title: "설정" })}>
            <Icon name="settings" />
        </Button>
    );
    const usageControl = (
        <Button type="button" appearance="icon"
            aria-label="사용량" title="사용량" aria-haspopup="dialog" aria-expanded={usageOpen}
            onClick={() => { openUsage(); if (narrow) mobile.setPanel(null); }}>
            <Icon name="usage" size={16} />
        </Button>
    );
    // 빈 영역의 버튼은 그 영역이 속한 프로젝트 배치에 연다. 단축키는 현재 프로젝트에 연다.
    const newTerminal = async (id = key) => {
        const projectId = projectAt(id) ?? (id === key ? selectedProjectId : undefined);
        const target = layouts[id];
        if (!projectId || !target || terminalPending.current || serverBlocked) return;
        if (L.allTabs(target).length >= L.MAX_TABS) {
            setCloseError("열린 탭이 많아요. 탭을 닫고 다시 시도해 주세요.");
            return;
        }
        terminalPending.current = true;
        setOpeningTerminal(true);
        setCloseError(null);
        try {
            const terminal = await api.post<{ id: string; name: string }>(`/projects/${projectId}/terminals`, { name: "터미널" });
            openAt(id, { kind: "terminal", project_id: projectId, resource_id: terminal.id, title: terminal.name });
        } catch (error) {
            setCloseError(error instanceof ApiError ? error.message : "터미널을 열지 못했어요.");
        } finally {
            terminalPending.current = false;
            setOpeningTerminal(false);
        }
    };
    const latestNewTerminal = useRef(newTerminal);
    latestNewTerminal.current = newTerminal;
    const newTerminalAt = useCallback((id: string) => { void latestNewTerminal.current(id); }, []);
    useWorkspaceShortcuts(keyboardShortcuts, (action) => {
        if (action === "settings") {
            open({ kind: "settings", title: "설정" });
        } else if (action === "newTerminal") {
            void newTerminal();
        } else if (action === "toggleSidebar") {
            if (!narrow) focusSidebarToggle.current = true;
            setSidebar((current) => !current);
        } else if (action === "closeTab") {
            if (usageOpen) { closeUsage(); return; }
            const tabId = layout && L.focusedLeaf(layout).active_tab;
            if (tabId) closeTab(key, tabId);
        } else {
            if (usageOpen) return;
            updateAt(key, (current) => applyTabShortcut(current, action, selectedProjectId ?? undefined));
        }
    });
    const selectedProject = projects.data?.find((p) => p.id === selectedProjectId);
    const mobileTabs = layout ? L.allTabs(layout).filter((tab) => tab.project_id === selectedProjectId || !tab.project_id) : [];
    const renderProject = (p: Project) => (
        <SidebarProject key={p.id} project={p} open={open} narrow={narrow}>
            <Stack direction="horizontal" align="center" gap={0} minHeight={32} data-testid="project-row" data-project={p.name} data-project-order-id={p.id}
                data-order-drop={projectDrop?.id === p.id ? projectDrop.after ? "after" : "before" : undefined}
                data-order-dragging={touchOrder?.id === p.id ? "true" : undefined}
                xstyle={[workspaceStyles.projectRow, touchOrder?.id === p.id && workspaceStyles.projectLift(touchOrder.dx, touchOrder.dy)]}
                onDragOver={(event) => {
                    const source = projects.data?.find((item) => item.id === draggingProject);
                    if (!event.dataTransfer.types.includes(DRAG_PROJECT) || !source || source.id === p.id
                        || (source.folder_id ?? null) !== (p.folder_id ?? null)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const box = event.currentTarget.getBoundingClientRect();
                    setDesktopDrop({ kind: "order", id: p.id, after: event.clientY > box.top + box.height / 2 });
                }}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDesktopDrop((current) => current?.kind === "order" && current.id === p.id ? null : current);
                    }
                }}
                onDrop={(event) => {
                    const target = parseProjectDrag(event.dataTransfer.getData(DRAG_PROJECT));
                    if (!target?.project_id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    reorder(target.project_id, p.id, event.clientY > box.top + box.height / 2);
                    setDraggingProject(null);
                    setDesktopDrop(null);
                }}>
                <Button appearance="navigation" aria-current={selectedProjectId === p.id ? "page" : undefined}
                    data-project-drag={p.id} data-swipe-blocked={narrow ? "true" : undefined} xstyle={workspaceStyles.projectDragHandle}
                    draggable={!narrow} onDragStart={(event) => {
                        setDraggingProject(p.id);
                        event.dataTransfer.setData(DRAG_PROJECT, JSON.stringify(projectTarget(p)));
                        event.dataTransfer.effectAllowed = "copyMove";
                    }}
                    onDragEnd={() => { setDraggingProject(null); setDesktopDrop(null); }}
                    onKeyDown={(event) => {
                        if (!event.altKey || !event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                        event.preventDefault();
                        const siblings = shown.filter((item) => (item.folder_id ?? null) === (p.folder_id ?? null));
                        const next = siblings[siblings.findIndex((item) => item.id === p.id) + (event.key === "ArrowUp" ? -1 : 1)];
                        if (next) reorder(p.id, next.id, event.key === "ArrowDown");
                    }}
                    onClick={() => { openProjectAt(baseKey, projectTarget(p), "here", true); if (narrow) setSidebar(false); }}
                    title={`${p.root_path} · ${narrow ? "길게 눌러 끌기" : "끌어서 순서 변경, 폴더 이동 또는 프로젝트 분할"} (Alt+Shift+↑/↓ 순서 변경)`}>
                    {p.pinned_at && <HintText aria-label="고정됨" hint="고정됨">📌</HintText>}
                    {p.icon && <GroveText type="inherit" color="inherit" aria-hidden>{p.icon}</GroveText>} <GroveText type="inherit" color="inherit" maxLines={1}>{p.name}</GroveText> {!p.available && <GroveText type="supporting" color="warning">(경로 없음)</GroveText>}
                </Button>
                <StackItem size="static">
                    <Popover label={`${p.name} 메뉴`} isOpen={menuFor === p.id}
                        onOpenChange={(value) => setMenuFor(value ? p.id : null)}
                        placement="below" alignment="end" width={240} padding={2} isModal={false} hasCloseButton={false}
                        content={menuFor === p.id ? <ProjectMenu project={p} onClose={() => setMenuFor(null)} onHistory={() => setHistoryProject(p)}
                            onRename={() => setRenamingProject(p)} /> : null}>
                        <Button type="button" variant="secondary" appearance="icon" width={32}
                            aria-label="프로젝트 메뉴" title={`${p.name} 메뉴`} onClick={(event) => { projectMenuTrigger.current = event.currentTarget; }}>⋯</Button>
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
                    {usageControl}{settingsControl}
                </Stack>
            </LayoutPanel>}
            <MobileDrawer enabled={narrow} side="left" open={mobile.panel === "left"} drag={mobile.drag}
                label="탐색 메뉴" headerActions={<>{create()}{usageControl}{settingsControl}</>} onClose={() => mobile.setPanel(null)}>
                <LayoutPanel width={narrow ? "100%" : undefined} resizable={narrow ? undefined : navigation}
                    hasDivider={!narrow} padding={0} isScrollable={false}
                    role="complementary" label="탐색" data-testid="sidebar" xstyle={workspaceStyles.navigation}>
                    <Stack gap={0} height="100%">
                    {!narrow && <Stack direction="horizontal" align="center" justify="between" gap={0} minHeight={40} paddingInline={4}>
                        {brand}{wideSidebar && <Stack direction="horizontal" align="center" gap={0}>
                            {usageControl}{settingsControl}{sidebarControl}
                        </Stack>}
                    </Stack>}
                    <StackItem size="fill" xstyle={workspaceStyles.projects}>
                    <ScrollableArea axis="block" label="프로젝트 목록" height="100%" data-testid="sidebar-scroll">
                    <Stack gap={1} paddingInline={2}>
                        <Stack as="section" gap={0} data-testid="projects"
                            onDragOver={(event) => {
                                if (event.defaultPrevented || !draggingProject || !event.dataTransfer.types.includes(DRAG_PROJECT)) return;
                                const folderId = projectFolderDropAt(event.target);
                                if (folderId === undefined || !canMoveToFolder(draggingProject, folderId)) { setDesktopDrop(null); return; }
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                setDesktopDrop((current) => current?.kind === "folder" && current.folderId === folderId
                                    ? current : { kind: "folder", folderId });
                            }}
                            onDragLeave={(event) => {
                                const folderId = projectFolderDropAt(event.target);
                                if (folderId === projectFolderDropAt(event.relatedTarget)) return;
                                setDesktopDrop((current) => current?.kind === "folder" && current.folderId === folderId ? null : current);
                            }}
                            onDrop={(event) => {
                                const folderId = projectFolderDropAt(event.target);
                                if (folderId === undefined || !draggingProject
                                    || parseProjectDrag(event.dataTransfer.getData(DRAG_PROJECT))?.project_id !== draggingProject) return;
                                event.preventDefault();
                                setDraggingProject(null);
                                setDesktopDrop(null);
                                applySidebarDrop(draggingProject, { kind: "folder", folderId });
                            }}>
                            <Stack direction="horizontal" align="center" justify="between" gap={0} minHeight={28} paddingInlineStart={2}>
                                <StackItem size="fill" data-testid="project-list-heading" data-project-folder-drop={showUnfiledDrop ? "" : undefined}
                                    data-folder-drop={dropFolderId === null || undefined} xstyle={[workspaceStyles.projectListHeading, dropFolderId === null && workspaceStyles.folderDrop]}>
                                    <Heading level={2} type="navigation" color="secondary">{showUnfiledDrop ? "폴더 밖으로 이동" : "프로젝트"}</Heading>
                                </StackItem>
                                {!narrow && create()}
                                <ActionMenu label="프로젝트 목록 옵션">
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
                                <Button type="button" variant="secondary" density="compact" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>보관됨</Button>
                                    </Stack>
                                </ActionMenu>
                            </Stack>
                            {showArchived && <ArchivedProjects />}
                            {Boolean(folders.error) && <GroveText type="supporting" color="error" role="alert">폴더를 불러오지 못했어요. <Button type="button" appearance="link" onClick={folders.reload}>다시 확인</Button></GroveText>}
                            {folderMoveBusy && <GroveText type="supporting" role="status">프로젝트 이동 중…</GroveText>}
                            {folderMoveError && <GroveText type="supporting" color="error" role="alert">{folderMoveError}{pendingFolderMove && <>{" "}
                                <ServerActionButton type="button" appearance="link" onClick={() => void saveFolderMove(pendingFolderMove.path, pendingFolderMove.body)}>같은 요청 결과 확인</ServerActionButton>
                            </>}</GroveText>}
                            <VisuallyHidden role="status">{touchOrder ? `${shown.find((p) => p.id === touchOrder.id)?.name ?? ""} 이동 중` : ""}</VisuallyHidden>
                            <ProjectFolderTree projects={shown} folders={folders.data ?? []} dropFolderId={dropFolderId} renderProject={renderProject} />
                        </Stack>
                    </Stack>
                    </ScrollableArea>
                    </StackItem>
                    <Stack gap={0} paddingInline={2} xstyle={workspaceStyles.recentDock}>
                        <RecentPanel open={openRecent} splitGroups={splitGroups} />
                    </Stack>
                    </Stack>
                </LayoutPanel>
            </MobileDrawer>
            <StackItem size="fill"><Stack gap={0} height="100%" xstyle={workspaceStyles.main}>
            <LayoutHeader height={40} padding={0} hasDivider role="banner" data-ui="workspace-header">
            <Stack direction="horizontal" align="center" height="100%" gap={narrow ? 1 : 2} paddingInline={narrow ? 2 : 4}>
                {narrow && sidebarControl}
                {(narrow || !wideSidebar) && brand}
                {/* 현재 위치는 별도 줄 대신 상단 바 안에 둔다. */}
                <NavigationContext layout={layout} projects={projects.data ?? NO_PROJECTS}
                    open={open} onBrowseProjects={() => setSidebar(true)} sidebarOpen={sidebar} />
                <ConnStatus status={status} retryAt={retryAt} onRetry={() => stream.current?.retryNow()} />
                {narrow && <Button variant="secondary" appearance="icon" aria-label="새 대화" title="새 대화"
                    disabled={!selectedProject || !selectedProject.available} onClick={() => {
                        if (!selectedProject) return;
                        open(projectTarget(selectedProject));
                        requestNewConversation(selectedProject.id);
                    }}><Icon name="plus" /></Button>}
                {narrow && <Button variant="secondary" appearance="icon" aria-label="열린 세션" title="열린 세션"
                    aria-expanded={mobile.panel === "right"} onClick={() => mobile.setPanel("right")}>
                    <Icon name="panel" />
                </Button>}
            </Stack>
            </LayoutHeader>
            {historyProject && <ProjectHistoryDialog key={historyProject.id} project={historyProject} onClose={closeHistory}
                open={(target, how) => { setHistoryProject(null); open(target, how); }} />}
            {renamingProject && <ProjectRenameDialog key={renamingProject.id} project={renamingProject} onClose={closeRename} />}
            {settingsTarget && <PushStatusContext.Provider value={pushStatus}><SettingsDialog key={`${settingsTarget.project_id ?? ""}:${settingsTarget.resource_id ?? ""}`}
                target={settingsTarget} projectName={projects.data?.find((p) => p.id === settingsTarget.project_id)?.name}
                open={open} onClose={() => setSettingsTarget(null)} /></PushStatusContext.Provider>}
            {adding === "project" && <AddProjectDialog blockedReason={serverBlocked} beforeMutation={requireServerAction} onDone={projectAdded} onClose={closeCreation} />}
            {adding === "folder" && <ProjectFolderDialog onDone={() => { setAdding(null); folders.reload(); }} onClose={closeCreation} />}
            {notice && (
                <Banner status="warning" role="status" title={notice} endContent={<Stack direction="horizontal" gap={2}>
                    <ServerActionButton variant="secondary" onClick={() => { setNotice(null); flush(); }}>배치 다시 저장</ServerActionButton>
                    <Button variant="secondary" onClick={() => setNotice(null)}>닫기</Button>
                </Stack>} />
            )}
            {closeError && <Banner status="error" role="alert" title={closeError} data-testid="tab-close-error"
                endContent={<Button variant="secondary" onClick={() => setCloseError(null)}>닫기</Button>} />}
            {openingTerminal && <LoadingBar label="터미널 여는 중…" />}
            {usageVisited && <CreationDialog label="사용량" isOpen={usageOpen} onClose={closeUsage} width="88em" xstyle={dashboardStyles.dialog}>
                <PaneVisibility value={usageOpen}><UsagePanel onClose={closeUsage}
                    onAuthenticate={(protocol) => { leaveUsage(); open({ kind: "settings", resource_id: `agent-auth:${protocol}`, title: "설정" }); }} /></PaneVisibility>
            </CreationDialog>}
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
                            <SavedLayout id={id} layout={saved} onUpdate={updateAt} onCloseTab={closeTab} closingTabs={closingTabs} onOpen={openAt} onProjectDrop={dropProject}
                                onCloseProject={geometry.panes.length > 1 ? closeProject : undefined} projectLabel={label}
                                projectId={projectId} onNewTerminal={newTerminalAt}
                                recentReveal={recentReveal?.layoutId === id && id === key ? recentReveal : undefined}
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
                                    onClick={() => { leaveUsage(); updateAt(key, (current) => L.activate(current, tab.id)); mobile.setPanel(null); }}>
                                    {L.tabTitle(tab)}
                                </Button>
                                <Button type="button" variant="secondary" appearance="icon" aria-label={`${L.tabTitle(tab)} 탭 닫기`}
                                    title={closingTabs.has(tab.id) ? "탭 닫는 중…" : tab.kind === "terminal" ? "탭을 닫고 터미널 프로세스를 종료합니다" : tab.kind === "session" ? "탭을 닫고 최근 목록에서 숨깁니다. 대화와 실행 중인 작업은 유지됩니다." : "화면만 닫습니다. 실행은 계속되며 작성 중인 입력은 저장되지 않습니다."}
                                    disabled={closingTabs.has(tab.id)} aria-busy={closingTabs.has(tab.id)}
                                    onClick={() => closeTab(key, tab.id)}>{closingTabs.has(tab.id) ? "…" : "×"}</Button>
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
        <>
        <HeaderUpdates connected={status === "live"} online={online} />
        {status !== "live" && <HintText color={status === "offline" || status === "auth_expired" ? "error" : "warning"} hint={`서버 연결 상태: ${label}`} data-testid="conn" role="status">
            <StatusDot variant={status === "offline" || status === "auth_expired" ? "error" : "warning"} label={label} />
            <VisuallyHidden>{label}</VisuallyHidden>
            {status === "offline" && (
                <Button variant="secondary" density="compact" onClick={onRetry}>
                    지금 재연결
                </Button>
            )}
        </HintText>}
        </>
    );
}
