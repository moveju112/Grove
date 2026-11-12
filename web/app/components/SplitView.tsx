import { useEffect, useRef, useState } from "react";
import type { Project } from "../api/generated";
import * as L from "../state/layout";
import { PaneVisibility } from "../state/paneVisibility";
import { FilesView } from "./FilesView";
import { ProjectView } from "./ProjectView";
import { SessionView } from "./SessionView";
import { Settings } from "./Settings";
import { TerminalView } from "./TerminalView";
import type { Opener } from "./Workspace";

type Props = { layout: L.Layout; update: (f: (l: L.Layout) => L.Layout) => void; open: Opener; narrow: boolean; visible: boolean; projects: Project[] };
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
    const all = L.leaves(p.layout.root);
    return (
        <div className="split-root" data-layout-mode={p.narrow ? "narrow" : "wide"} hidden={!p.visible} inert={!p.visible} onKeyDownCapture={(e) => {
            if (zoom && e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMaximized(null);
            }
        }}>
            {p.narrow && all.length > 1 && (
                <nav className="pane-switch" aria-label="pane 전환">
                    {all.map((leaf, i) => (
                        <button key={leaf.id} className={leaf.id === p.layout.focused_leaf ? "on" : ""} onClick={() => p.update((l) => L.focus(l, leaf.id))}>
                            영역 {i + 1}
                        </button>
                    ))}
                </nav>
            )}
            <NodeView {...view} node={p.layout.root} path={[]} />
        </div>
    );
}

function NodeView(p: ViewProps & { node: L.Node; path: number[] }) {
    const ref = useRef<HTMLDivElement>(null);
    if (p.node.type === "leaf") return <PaneView {...p} leaf={p.node} />;
    const n = p.node;
    const single = p.narrow ? p.layout.focused_leaf : p.maximized;
    const shown = (node: L.Node) => !single || L.leaves(node).some((leaf) => leaf.id === single);
    const onDrag = (e: React.PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
            const r = n.direction === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
            p.update((l) => L.setRatio(l, p.path, r));
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
        <div ref={ref} className={`split ${n.direction}`} data-testid={`split-${n.direction}`}>
            <div className="split-child" hidden={!shown(n.children[0])} style={{ flexBasis: single ? "100%" : `${n.ratio * 100}%` }}>
                <NodeView {...p} node={n.children[0]} path={[...p.path, 0]} />
            </div>
            <div
                className="divider"
                hidden={!!single}
                role="separator"
                aria-orientation={n.direction === "row" ? "vertical" : "horizontal"}
                aria-valuenow={Math.round(n.ratio * 100)}
                aria-label="영역 크기 조절"
                tabIndex={0}
                onPointerDown={onDrag}
                onKeyDown={onKey}
                onDoubleClick={() => p.update((l) => L.setDirection(l, p.path, n.direction === "row" ? "column" : "row"))}
                title="끌어서 크기 조절 · 더블클릭으로 방향 전환"
            />
            <div className="split-child" hidden={!shown(n.children[1])} style={{ flexBasis: single ? "100%" : `${(1 - n.ratio) * 100}%` }}>
                <NodeView {...p} node={n.children[1]} path={[...p.path, 1]} />
            </div>
        </div>
    );
}

const { DRAG_TAB, DRAG_OPEN } = L;
const EDGE_LABEL: Record<(typeof L.SPLIT_EDGES)[number], string> = { left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };

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

const draggable = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TAB) || e.dataTransfer.types.includes(DRAG_OPEN);

function PaneView(p: ViewProps & { leaf: L.Leaf }) {
    const { leaf } = p;
    const focused = p.layout.focused_leaf === leaf.id;
    const active = leaf.tabs.find((t) => t.id === leaf.active_tab);
    const activeIndex = leaf.tabs.findIndex((t) => t.id === leaf.active_tab);
    const others = L.leaves(p.layout.root).filter((x) => x.id !== leaf.id);
    const projectName = (id?: string) => p.projects.find((x) => x.id === id)?.name;
    const visible = p.visible && (!p.narrow || focused) && (!p.maximized || p.maximized === leaf.id);
    const [zone, setZone] = useState<L.DropEdge | null>(null);
    const splittable = L.canSplit(p.layout, leaf.id);
    const drop = (e: React.DragEvent, edge: L.DropEdge, index?: number) => {
        e.preventDefault();
        e.stopPropagation();
        setZone(null);
        const tabId = e.dataTransfer.getData(DRAG_TAB);
        if (tabId) {
            p.update((l) => L.placeTab(l, tabId, leaf.id, edge, index));
            return;
        }
        const target = L.parseOpenTarget(e.dataTransfer.getData(DRAG_OPEN));
        if (target) p.update((l) => L.openAtEdge(l, leaf.id, edge, target));
    };
    const menu = (value: string) => {
        if (!active || !value) return;
        const [kind, arg] = value.split(":") as [string, string];
        if (kind === "leaf") p.update((l) => L.moveTab(l, active.id, arg));
        else if (kind === "order") p.update((l) => L.placeTab(l, active.id, leaf.id, "center", activeIndex + Number(arg)));
        else if (kind === "edge") p.update((l) => L.placeTab(l, active.id, leaf.id, arg as L.DropEdge));
    };
    return (
        <PaneVisibility.Provider value={visible}>
        <section className={`pane ${focused ? "focused" : ""}`} data-testid="pane" data-leaf={leaf.id}
            // pointer뿐 아니라 키보드(Tab) 포커스 진입도 현재 pane으로 삼아, 사이드바에서 여는 항목이 입력 중인 pane에 열리게 한다(PANE-006).
            onPointerDownCapture={() => !focused && p.update((l) => L.focus(l, leaf.id))}
            onFocusCapture={() => !focused && visible && p.update((l) => L.focus(l, leaf.id))}
            onDragOver={(e) => {
                if (!draggable(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TAB) ? "move" : "copy";
                const next = dropZone(e, p.narrow);
                setZone(next !== "center" && !splittable ? "center" : next);
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setZone(null)}
            onDrop={(e) => draggable(e) && drop(e, zone ?? "center")}
        >
            {zone && <div className={`drop-zone ${zone}`} data-testid="drop-zone" data-zone={zone} aria-hidden="true" />}
            <div className="tabbar" role="tablist">
                {leaf.tabs.map((t, i) => (
                    <div key={t.id} className={`tab ${t.id === leaf.active_tab ? "on" : ""}`} role="tab" aria-selected={t.id === leaf.active_tab}
                        onDragOver={(e) => {
                            if (!draggable(e)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setZone(null);
                        }}
                        onDrop={(e) => draggable(e) && drop(e, "center", i)}
                    >
                        <button className="tab-title" onClick={() => p.update((l) => L.activate(l, t.id))} title={`${t.title} · 끌어서 다른 영역이나 가장자리로 이동(Alt+Shift+←/→ 순서 변경)`}
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
                            {t.kind !== "settings" && <span className="badge">{projectName(t.project_id) ?? "?"}</span>}
                            {t.kind === "project" ? "대화 목록" : t.title}
                        </button>
                        <button className="ghost small" aria-label="탭 닫기" title="화면만 닫습니다(작업은 계속)" onClick={() => p.update((l) => L.closeTab(l, t.id))}>
                            ×
                        </button>
                    </div>
                ))}
                <span className="spacer" />
                {!p.narrow && active && (
                    <>
                        <button className="ghost small" title="오른쪽으로 분할" aria-label="오른쪽으로 분할" onClick={() => p.update((l) => L.splitLeaf(l, leaf.id, "row", copyOf(active)))}>
                            ◫
                        </button>
                        <button className="ghost small" title="아래로 분할" aria-label="아래로 분할" onClick={() => p.update((l) => L.splitLeaf(l, leaf.id, "column", copyOf(active)))}>
                            ⊟
                        </button>
                        <select aria-label="탭 이동" value="" onChange={(e) => menu(e.target.value)}>
                            <option value="">이동…</option>
                            {leaf.tabs.length > 1 && <>
                                <option value="order:-1" disabled={activeIndex <= 0}>탭을 앞으로</option>
                                <option value="order:1" disabled={activeIndex >= leaf.tabs.length - 1}>탭을 뒤로</option>
                            </>}
                            {others.map((o, i) => (
                                <option key={o.id} value={`leaf:${o.id}`}>
                                    영역 {i + 1}
                                </option>
                            ))}
                            {leaf.tabs.length > 1 && splittable && L.SPLIT_EDGES.map((edge) => (
                                <option key={edge} value={`edge:${edge}`}>{EDGE_LABEL[edge]} 새 영역으로</option>
                            ))}
                        </select>
                    </>
                )}
                {others.length > 0 && (
                    <>
                        {!p.narrow && <button className="ghost small" aria-label={p.maximized === leaf.id ? "분할 복원" : "영역 전체 보기"}
                            aria-pressed={p.maximized === leaf.id} title="화면 배치만 변경합니다(작업은 계속)"
                            onClick={() => p.toggleMaximize(leaf.id)}>
                            {p.maximized === leaf.id ? "분할 복원" : "전체 보기"}
                        </button>}
                        <button className="ghost small" title="영역 닫기(탭은 인접 영역으로 합침, 작업은 계속)" aria-label="영역 닫기"
                            onClick={() => p.update((l) => L.closeLeaf(l, leaf.id))}>⊠</button>
                    </>
                )}
            </div>
            <div className="pane-body">
                {!active && <EmptyPane />}
                {active?.kind === "session" && active.resource_id && active.project_id && (
                    <SessionView key={active.id} tabId={active.id} sessionId={active.resource_id} projectId={active.project_id} open={p.open} />
                )}
                {active?.kind === "project" && active.project_id && <ProjectView key={active.id} tabId={active.id} projectId={active.project_id} open={p.open} />}
                {active?.kind === "file" && active.project_id && <FilesView key={active.id} tabId={active.id} projectId={active.project_id}
                    initial={L.fileTarget(active)} />}
                {active?.kind === "terminal" && active.project_id && active.resource_id && (
                    <TerminalView key={active.id} projectId={active.project_id} terminalId={active.resource_id} />
                )}
                {active?.kind === "settings" && (
                    <Settings
                        key={active.id}
                        projectId={active.project_id ?? undefined}
                        projectName={projectName(active.project_id)}
                        sessionId={active.resource_id?.startsWith("session:") ? active.resource_id.slice(8) : undefined}
                    />
                )}
            </div>
        </section>
        </PaneVisibility.Provider>
    );
}

/// 같은 자원을 다른 pane에서 보기 위한 tab 사본(새 tab ID는 openTab이 만든다).
function copyOf(t: L.Tab): Omit<L.Tab, "id"> {
    const { id: _id, ...rest } = t;
    return rest;
}

function EmptyPane() {
    return (
        <div className="empty">
            <p>왼쪽 최근 목록이나 프로젝트에서 대화를 여세요.</p>
            <p className="muted">각 영역은 서로 다른 프로젝트를 열 수 있고, 요청은 그 탭의 프로젝트에만 실행됩니다.</p>
        </div>
    );
}
