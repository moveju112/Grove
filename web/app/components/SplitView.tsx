import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { SPLIT_DIVIDER_SIZE, splitStyles } from "./split-layout.stylex";
import { Divider } from "@astryxdesign/core/Divider";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../api/generated";
import * as L from "../state/layout";
import { PaneVisibility } from "../state/paneVisibility";
import { FilesView } from "./FilesView";
import type { Opener } from "./Workspace";
import { LoadingBar } from "./LoadingScreen";
import { Icon } from "./icons";
import { DRAG_PROJECT, parseProjectDrag } from "../state/projectOrder";
import { SessionActivityIndicator } from "./session-activity/SessionActivityIndicator";
import { PaneToolsTarget } from "./ui/Controls";

const TerminalView = lazy(async () => ({ default: (await import("./TerminalView")).TerminalView }));
const ProjectView = lazy(async () => ({ default: (await import("./ProjectView")).ProjectView }));
const SessionView = lazy(async () => ({ default: (await import("./SessionView")).SessionView }));

export type RecentPaneReveal = { leafId: string; tabId: string; request: number };
type Props = { layout: L.Layout; update: (f: (l: L.Layout) => L.Layout) => void; open: Opener; narrow: boolean; visible: boolean; projects: Project[];
    closeTab: (tabId: string) => void; closingTabs: ReadonlySet<string>;
    projectLabel?: string; recentReveal?: RecentPaneReveal;
    onProjectDrop?: (target: Omit<L.Tab, "id">, edge: L.DropEdge) => void; onCloseProject?: () => void };
type ViewProps = Props & { maximized: string | null; toggleMaximize: (leafId: string) => void };

export function SplitView(p: Props) {
    const [maximized, setMaximized] = useState<string | null>(null);
    useEffect(() => {
        setMaximized((id) => p.narrow || id !== p.layout.focused_leaf ? null : id);
    }, [p.narrow, p.layout.focused_leaf]);
    // 전체 보기는 배치를 바꾸지 않는다. 다른 자원으로 이동하면 숨겨진 pane에 갇히지 않도록 해제한다.
    const zoom = !p.narrow && maximized === p.layout.focused_leaf && L.leaves(p.layout.root).length > 1 ? maximized : null;
    const view: ViewProps = { ...p, maximized: zoom, toggleMaximize: (id) => {
        p.update((l) => L.focus(l, id));
        setMaximized(zoom === id ? null : id);
    } };
    return (
        <Stack gap={0} xstyle={splitStyles.fill} data-layout-mode={p.narrow ? "narrow" : "wide"} hidden={!p.visible} inert={!p.visible} onKeyDownCapture={(e) => {
            if (zoom && e.key === "Escape") {
                // 열린 모달의 Escape는 Astryx가 처리한다.
                if (e.currentTarget.ownerDocument.querySelector("dialog:modal")) return;
                e.preventDefault();
                e.stopPropagation();
                setMaximized(null);
            }
        }}>
            <NodeView {...view} node={p.layout.root} path={[]} />
        </Stack>
    );
}

function NodeView(p: ViewProps & { node: L.Node; path: number[] }) {
    const ref = useRef<HTMLDivElement>(null);
    if (p.node.type === "leaf") return <PaneView {...p} leaf={p.node} />;
    const n = p.node;
    const single = p.narrow ? p.layout.focused_leaf : p.maximized;
    const shown = (node: L.Node) => !single || L.leaves(node).some((leaf) => leaf.id === single);
    const firstDividers = (L.splitRegionCount(n.children[0], n.direction) - 1) * SPLIT_DIVIDER_SIZE;
    const secondDividers = (L.splitRegionCount(n.children[1], n.direction) - 1) * SPLIT_DIVIDER_SIZE;
    const dividers = firstDividers + secondDividers + SPLIT_DIVIDER_SIZE;
    // 내용 영역에 비율을 적용한 뒤 각 하위 영역의 구분선 폭을 더한다.
    const basis = (share: number, inside: number) => single ? "100%" : `calc(${share * 100}% + ${inside}px - ${share * dividers}px)`;
    const onDrag = (e: React.PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
            const offset = n.direction === "row" ? ev.clientX - rect.left : ev.clientY - rect.top;
            const size = (n.direction === "row" ? rect.width : rect.height) - dividers;
            if (size > 0) p.update((l) => L.setRatio(l, p.path, (offset - firstDividers - SPLIT_DIVIDER_SIZE / 2) / size));
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    const onKey = (e: React.KeyboardEvent) => {
        const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -0.05 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 0.05 : 0;
        if (d) {
            e.preventDefault();
            p.update((l) => L.setRatio(l, p.path, n.ratio + d));
        }
    };
    return (
        <Stack ref={ref} gap={0} direction={n.direction === "row" ? "horizontal" : "vertical"} xstyle={splitStyles.fill} data-testid={`split-${n.direction}`}>
            <Stack direction="horizontal" gap={0} xstyle={splitStyles.child(basis(n.ratio, firstDividers))} hidden={!shown(n.children[0])}>
                <NodeView {...p} node={n.children[0]} path={[...p.path, 0]} />
            </Stack>
            <Divider
                xstyle={[splitStyles.divider, n.direction === "row" ? splitStyles.horizontal : splitStyles.vertical]}
                hidden={!!single}
                role="separator"
                orientation={n.direction === "row" ? "vertical" : "horizontal"}
                aria-valuenow={Math.round(n.ratio * 100)}
                aria-label="영역 크기 조절"
                tabIndex={0}
                onPointerDown={onDrag}
                onKeyDown={onKey}
                onDoubleClick={() => p.update((l) => L.setDirection(l, p.path, n.direction === "row" ? "column" : "row"))}
                aria-description="끌어서 크기 조절 · 더블클릭으로 방향 전환"
            />
            <Stack direction="horizontal" gap={0} xstyle={splitStyles.child(basis(1 - n.ratio, secondDividers))} hidden={!shown(n.children[1])}>
                <NodeView {...p} node={n.children[1]} path={[...p.path, 1]} />
            </Stack>
        </Stack>
    );
}

const { DRAG_TAB, DRAG_OPEN } = L;

// pane 가장자리 25% 안이면 그 방향 분할, 아니면 그 pane에 넣는다. 좁은 화면은 분할하지 않는다.
function dropZone(e: React.DragEvent<HTMLElement>, narrow: boolean): L.DropEdge {
    if (narrow) return "center";
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const near = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]] as const;
    const [edge, dist] = near.reduce((a, b) => (b[1] < a[1] ? b : a));
    return dist < 0.25 ? edge : "center";
}

const draggable = (e: React.DragEvent) => [DRAG_TAB, DRAG_OPEN, DRAG_PROJECT].some((kind) => e.dataTransfer.types.includes(kind));

function PaneView(p: ViewProps & { leaf: L.Leaf }) {
    const { leaf } = p;
    const focused = p.layout.focused_leaf === leaf.id;
    const active = leaf.tabs.find((t) => t.id === leaf.active_tab);
    const syncTitle = useCallback((title: string) => p.update((layout) => {
        const tab = L.allTabs(layout).find((item) => item.id === leaf.active_tab);
        return tab?.kind === "session" && tab.title !== title ? L.replaceTab(layout, tab.id, { ...tab, title }) : layout;
    }), [p.update, leaf.active_tab]);
    const others = L.leaves(p.layout.root).filter((x) => x.id !== leaf.id);
    const maximized = p.maximized === leaf.id;
    const maximizeLabel = maximized ? "분할 복원" : "영역 전체 보기";
    const projectName = (id?: string) => p.projects.find((x) => x.id === id)?.name;
    const visible = p.visible && (!p.narrow || focused) && (!p.maximized || p.maximized === leaf.id);
    const reveal = visible && focused && !p.narrow && (p.onCloseProject || (!p.maximized && others.length > 0))
        && p.recentReveal?.leafId === leaf.id && p.recentReveal.tabId === leaf.active_tab ? p.recentReveal : undefined;
    const [zone, setZone] = useState<L.DropEdge | null>(null);
    const [toolsTarget, setToolsTarget] = useState<HTMLElement | null>(null);
    const tabRow = useRef<HTMLDivElement>(null);
    const tabList = useRef<HTMLDivElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const row = tabRow.current, list = tabList.current;
        if (!row || !list || p.narrow || !visible) return;
        const reveal = () => {
            const tab = list.querySelector('[aria-selected="true"]');
            if (!tab) return;
            // scrollIntoView는 상위 작업 공간까지 스크롤할 수 있으므로 탭 줄만 움직인다.
            const scroller = getComputedStyle(row).overflowX === "scroll" ? row : list;
            const { left } = scroller.getBoundingClientRect();
            const { left: start, right: end } = tab.getBoundingClientRect();
            const delta = start < left ? start - left : Math.min(start - left, end - left - scroller.clientWidth);
            if (delta > 0 || start < left) scroller.scrollBy({ left: delta });
        };
        reveal();
        const observer = new ResizeObserver(reveal);
        observer.observe(row);
        observer.observe(list);
        return () => observer.disconnect();
    }, [leaf.active_tab, p.narrow, visible]);
    const splittable = L.canSplit(p.layout, leaf.id);
    const projectId = active?.project_id ?? leaf.tabs.find((tab) => tab.project_id)?.project_id;
    const newConversation = () => {
        if (!projectId) return;
        p.update((l) => L.openAtEdge(l, leaf.id, "center", { kind: "project", project_id: projectId, title: "새 대화" }));
    };
    const drop = (e: React.DragEvent, edge: L.DropEdge, index?: number) => {
        e.preventDefault();
        e.stopPropagation();
        setZone(null);
        if (e.dataTransfer.types.includes(DRAG_PROJECT)) {
            const target = parseProjectDrag(e.dataTransfer.getData(DRAG_PROJECT));
            if (target) p.onProjectDrop?.(target, edge);
            return;
        }
        const tabId = e.dataTransfer.getData(DRAG_TAB);
        if (tabId) {
            p.update((l) => L.placeTab(l, tabId, leaf.id, edge, index));
            return;
        }
        const target = L.parseOpenTarget(e.dataTransfer.getData(DRAG_OPEN));
        if (target) {
            const projectId = L.allTabs(p.layout).find((tab) => tab.project_id)?.project_id;
            if (projectId !== target.project_id) p.open(target);
            else p.update((l) => L.openAtEdge(l, leaf.id, edge, target));
        }
    };
    return (
        <PaneVisibility.Provider value={visible}>
        <PaneToolsTarget.Provider value={p.narrow ? null : toolsTarget}>
        <Stack as="section" gap={0} xstyle={splitStyles.pane} data-focused={focused} data-testid="pane" data-leaf={leaf.id}
            // pointer뿐 아니라 키보드(Tab) 포커스 진입도 현재 pane으로 삼아, 사이드바에서 여는 항목이 입력 중인 pane에 열리게 한다(PANE-006).
            onPointerDownCapture={() => !focused && p.update((l) => L.focus(l, leaf.id))}
            onFocusCapture={() => !focused && visible && p.update((l) => L.focus(l, leaf.id))}
            onDragOver={(e) => {
                if (!draggable(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TAB) ? "move" : "copy";
                const next = dropZone(e, p.narrow);
                setZone(next !== "center" && !splittable && !e.dataTransfer.types.includes(DRAG_PROJECT) ? "center" : next);
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setZone(null)}
            onDrop={(e) => draggable(e) && drop(e, zone ?? "center")}
        >
            {reveal && <Stack key={reveal.request} xstyle={splitStyles.recentReveal} data-testid="recent-pane-reveal" aria-hidden="true" />}
            {zone && <Stack xstyle={splitStyles.drop} data-testid="drop-zone" data-zone={zone} aria-hidden="true" />}
            {/* 모바일의 열린 탭은 오른쪽 서랍에서 전환한다. */}
            <Stack ref={tabRow} direction="horizontal" align="start" gap={0} xstyle={splitStyles.tabs} hidden={p.narrow}
                // 탭 줄은 pane의 위쪽 가장자리여도 분할하지 않고 탭을 합친다.
                onDragOver={(e) => {
                    if (!draggable(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TAB) ? "move" : "copy";
                    setZone(null);
                }}
                onDrop={(e) => draggable(e) && drop(e, "center")}
            >
                {p.projectLabel && <GroveText type="supporting" color="secondary" maxLines={1} xstyle={splitStyles.projectName}>{p.projectLabel}</GroveText>}
                <Stack ref={tabList} direction="horizontal" align="center" gap={0} xstyle={splitStyles.tabList} role="tablist" aria-label="열린 대화와 화면">
                {leaf.tabs.map((t, i) => (
                    <Stack direction="horizontal" align="center" gap={0.5} key={t.id} xstyle={splitStyles.tab} role="tab" aria-selected={t.id === leaf.active_tab}
                        onDragOver={(e) => {
                            if (!draggable(e)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setZone(null);
                        }}
                        onDrop={(e) => draggable(e) && drop(e, "center", i)}
                    >
                        <GroveButton type="button" appearance="disclosure" density="compact" xstyle={splitStyles.title} data-testid="tab-title" onClick={() => p.update((l) => L.activate(l, t.id))} title={`${projectName(t.project_id) ?? ""} · ${L.tabTitle(t)} · 끌어서 다른 영역이나 가장자리로 이동(Alt+Shift+←/→ 순서 변경)`}
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.setData(DRAG_TAB, t.id);
                                e.dataTransfer.effectAllowed = "move";
                            }}
                            onKeyDown={(e) => {
                                if (!e.altKey || !e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                                e.preventDefault();
                                const index = i + (e.key === "ArrowLeft" ? -1 : 1);
                                if (index >= 0 && index < leaf.tabs.length) p.update((l) => L.placeTab(l, t.id, leaf.id, "center", index));
                            }}
                        >
                            <GroveText type="inherit" color="inherit" maxLines={1} hasTruncateTooltip={false} xstyle={splitStyles.titleText}>
                                {L.tabTitle(t)}
                            </GroveText>
                        </GroveButton>
                        <GroveButton appearance="icon" density="compact" xstyle={splitStyles.close} aria-label="탭 닫기"
                            title={p.closingTabs.has(t.id) ? "탭 닫는 중…" : t.kind === "terminal" ? "탭을 닫고 터미널 프로세스를 종료합니다" : t.kind === "session" ? "탭을 닫고 최근 목록에서 숨깁니다(대화·작업은 유지)" : "화면만 닫습니다(작업은 계속)"}
                            disabled={p.closingTabs.has(t.id)} aria-busy={p.closingTabs.has(t.id)} onClick={() => p.closeTab(t.id)}>
                            {p.closingTabs.has(t.id) ? "…" : <Icon name="close" size={12} />}
                        </GroveButton>
                    </Stack>
                ))}
                </Stack>
                {projectId && <GroveButton variant="secondary" appearance="icon" density="compact" xstyle={splitStyles.newConversation}
                    aria-label="새 대화 탭" title="새 대화" disabled={L.allTabs(p.layout).length >= L.MAX_TABS}
                    onClick={newConversation}><Icon name="plus" size={16} /></GroveButton>}
                <Stack direction="horizontal" align="center" gap={1} xstyle={splitStyles.tabActions} data-testid="pane-tab-actions">
                {p.onCloseProject && <GroveButton variant="secondary" appearance="icon" density="compact" aria-label="프로젝트 분할 닫기"
                    title="프로젝트 화면만 닫습니다. 실행은 계속되며 작성 중인 입력은 저장되지 않습니다." onClick={p.onCloseProject}><Icon name="close" size={12} /></GroveButton>}
                {others.length > 0 && (
                    <>
                        {!p.narrow && <GroveButton appearance="icon" density="compact" aria-label={maximizeLabel}
                            aria-pressed={maximized} title={`${maximizeLabel} · 화면 배치만 변경합니다(작업은 계속)`}
                            onClick={() => p.toggleMaximize(leaf.id)}>
                            <Icon name={maximized ? "minimize" : "maximize"} size={16} />
                        </GroveButton>}
                        <GroveButton variant="secondary" density="compact" title="영역 닫기(탭은 인접 영역으로 합침, 작업은 계속)" aria-label="영역 닫기"
                            onClick={() => p.update((l) => L.closeLeaf(l, leaf.id))}>⊠</GroveButton>
                    </>
                )}
                <Stack as="div" ref={setToolsTarget} direction="horizontal" gap={0} data-testid="pane-tools-trigger" />
                </Stack>
            </Stack>
            <Stack gap={0} xstyle={splitStyles.viewport} data-testid="pane-viewport">
            <StackItem ref={viewport} size="fill" isScrollable xstyle={splitStyles.body} data-testid="pane-body">
                <Suspense fallback={<LoadingBar label="화면 여는 중…" />}>
                {active?.kind === "session" && active.resource_id && active.project_id && (
                    <SessionView key={active.id} tabId={active.id} sessionId={active.resource_id} projectId={active.project_id} open={p.open} onTitleChange={syncTitle} />
                )}
                {active?.kind === "project" && active.project_id && <ProjectView key={active.id} tabId={active.id} projectId={active.project_id}
                    open={!active.resource_id ? (target, how) => {
                        if (how && how !== "here") p.open(target, how);
                        else if (target.kind === "session" && target.project_id === active.project_id) p.update((l) => L.replaceTab(l, active.id, target));
                        else p.open(target, how);
                    } : p.open} />}
                {active?.kind === "file" && active.project_id && <FilesView key={active.id} tabId={active.id} projectId={active.project_id}
                    initial={L.fileTarget(active)} />}
                {active?.kind === "terminal" && active.project_id && active.resource_id && (
                    <TerminalView key={active.id} projectId={active.project_id} terminalId={active.resource_id} focused={focused && visible} />
                )}
                </Suspense>
            </StackItem>
            {active?.kind === "session" && active.resource_id &&
                <SessionActivityIndicator key={active.id} sessionId={active.resource_id} visible={visible} viewportRef={viewport} />}
            </Stack>
        </Stack>
        </PaneToolsTarget.Provider>
        </PaneVisibility.Provider>
    );
}
