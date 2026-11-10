import { useRef } from "react";
import type { Project } from "../api/generated";
import * as L from "../state/layout";
import { FilesView } from "./FilesView";
import { ProjectView } from "./ProjectView";
import { SessionView } from "./SessionView";
import { Settings } from "./Settings";
import { TerminalView } from "./TerminalView";
import type { Opener } from "./Workspace";

type Props = { layout: L.Layout; update: (f: (l: L.Layout) => L.Layout) => void; open: Opener; narrow: boolean; projects: Project[] };

export function SplitView(p: Props) {
    if (p.narrow) {
        // 좁은 화면: 포커스된 pane 하나만 보여 주고, 다른 pane은 전환 메뉴로 접근한다(상태는 보존).
        const all = L.leaves(p.layout.root);
        return (
            <div className="split-root">
                {all.length > 1 && (
                    <nav className="pane-switch" aria-label="pane 전환">
                        {all.map((leaf, i) => (
                            <button key={leaf.id} className={leaf.id === p.layout.focused_leaf ? "on" : ""} onClick={() => p.update((l) => L.focus(l, leaf.id))}>
                                영역 {i + 1}
                            </button>
                        ))}
                    </nav>
                )}
                <PaneView {...p} leaf={L.focusedLeaf(p.layout)} />
            </div>
        );
    }
    return (
        <div className="split-root">
            <NodeView {...p} node={p.layout.root} path={[]} />
        </div>
    );
}

function NodeView(p: Props & { node: L.Node; path: number[] }) {
    const ref = useRef<HTMLDivElement>(null);
    if (p.node.type === "leaf") return <PaneView {...p} leaf={p.node} />;
    const n = p.node;
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
            <div className="split-child" style={{ flexBasis: `${n.ratio * 100}%` }}>
                <NodeView {...p} node={n.children[0]} path={[...p.path, 0]} />
            </div>
            <div
                className="divider"
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
            <div className="split-child" style={{ flexBasis: `${(1 - n.ratio) * 100}%` }}>
                <NodeView {...p} node={n.children[1]} path={[...p.path, 1]} />
            </div>
        </div>
    );
}

function PaneView(p: Props & { leaf: L.Leaf }) {
    const { leaf } = p;
    const focused = p.layout.focused_leaf === leaf.id;
    const active = leaf.tabs.find((t) => t.id === leaf.active_tab);
    const others = L.leaves(p.layout.root).filter((x) => x.id !== leaf.id);
    const projectName = (id?: string) => p.projects.find((x) => x.id === id)?.name;
    return (
        <section className={`pane ${focused ? "focused" : ""}`} onPointerDownCapture={() => !focused && p.update((l) => L.focus(l, leaf.id))} data-testid="pane" data-leaf={leaf.id}>
            <div className="tabbar" role="tablist">
                {leaf.tabs.map((t) => (
                    <div key={t.id} className={`tab ${t.id === leaf.active_tab ? "on" : ""}`} role="tab" aria-selected={t.id === leaf.active_tab}>
                        <button className="tab-title" onClick={() => p.update((l) => L.activate(l, t.id))} title={t.title}>
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
                        {others.length > 0 && (
                            <select
                                aria-label="다른 영역으로 이동"
                                value=""
                                onChange={(e) => e.target.value && p.update((l) => L.moveTab(l, active.id, e.target.value))}
                            >
                                <option value="">이동…</option>
                                {others.map((o, i) => (
                                    <option key={o.id} value={o.id}>
                                        영역 {i + 1}
                                    </option>
                                ))}
                            </select>
                        )}
                        {others.length > 0 && (
                            <button className="ghost small" title="영역 닫기(탭은 다른 영역으로 합침)" aria-label="영역 닫기" onClick={() => p.update((l) => L.closeLeaf(l, leaf.id))}>
                                ⊠
                            </button>
                        )}
                    </>
                )}
            </div>
            <div className="pane-body">
                {!active && <EmptyPane />}
                {active?.kind === "session" && active.resource_id && active.project_id && (
                    <SessionView key={active.id} tabId={active.id} sessionId={active.resource_id} projectId={active.project_id} open={p.open} />
                )}
                {active?.kind === "project" && active.project_id && <ProjectView key={active.id} projectId={active.project_id} open={p.open} />}
                {active?.kind === "file" && active.project_id && <FilesView key={active.id} projectId={active.project_id} initial={active.resource_id} />}
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
