// 분할 화면 상태(PANE-001~009). 순수 함수만 두고 서버 검증 규칙(workspace.rs validate_layout)과 같은 제약을 지킨다.
// 각 tab은 project_id/resource_id에 고정되며(PANE-002), 전역 "현재 프로젝트"는 없다.

export type TabKind = "session" | "project" | "settings" | "file" | "terminal";
export type Tab = { id: string; kind: TabKind; project_id?: string; resource_id?: string; title: string; filePath?: string; fileLine?: number };
export type Leaf = { type: "leaf"; id: string; tabs: Tab[]; active_tab: string | null };
export type Split = { type: "split"; direction: "row" | "column"; ratio: number; children: [Node, Node] };
export type Node = Leaf | Split;
export type Layout = { schema: 1; root: Node; focused_leaf: string };

export const MAX_LEAVES = 16;
export const MAX_TABS = 64;
export const MAX_DEPTH = 8;

let counter = 0;
export function uid(prefix: string): string {
    counter += 1;
    const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return `${prefix}${rnd}${counter}`;
}

export function emptyLayout(): Layout {
    const id = uid("L");
    return { schema: 1, root: { type: "leaf", id, tabs: [], active_tab: null }, focused_leaf: id };
}

export function leaves(n: Node): Leaf[] {
    return n.type === "leaf" ? [n] : [...leaves(n.children[0]), ...leaves(n.children[1])];
}

export function allTabs(l: Layout): Tab[] {
    return leaves(l.root).flatMap((x) => x.tabs);
}

export function findLeaf(l: Layout, id: string): Leaf | undefined {
    return leaves(l.root).find((x) => x.id === id);
}

export function focusedLeaf(l: Layout): Leaf {
    return findLeaf(l, l.focused_leaf) ?? leaves(l.root)[0]!;
}

function mapLeaf(n: Node, id: string, f: (leaf: Leaf) => Node): Node {
    if (n.type === "leaf") return n.id === id ? f(n) : n;
    return { ...n, children: [mapLeaf(n.children[0], id, f), mapLeaf(n.children[1], id, f)] };
}

// 새 파일 탭은 경로와 줄을 분리한다. 예전 배치의 "경로:줄"과 탐색기 ID만 호환한다.
export function fileTarget(tab: Pick<Tab, "resource_id" | "title" | "filePath" | "fileLine">): { path: string; line?: number } | null {
    if (typeof tab.filePath === "string" && tab.filePath) return {
        path: tab.filePath, line: Number.isSafeInteger(tab.fileLine) && tab.fileLine! > 0 ? tab.fileLine : undefined,
    };
    if (!tab.resource_id || (tab.resource_id === "files" && tab.title.startsWith("파일 · "))) return null;
    const match = tab.resource_id.match(/^(.*?)(?::(\d+))?$/);
    return match?.[1] ? { path: match[1], line: match[2] ? Number(match[2]) : undefined } : null;
}

function sameResource(a: Tab, b: Tab): boolean {
    if (a.kind !== b.kind || a.project_id !== b.project_id) return false;
    if (a.kind !== "file") return a.resource_id === b.resource_id;
    const x = fileTarget(a), y = fileTarget(b);
    return x?.path === y?.path && x?.line === y?.line;
}

/// 탭 열기. 같은 pane에 같은 자원이 있으면 새로 만들지 않고 활성화한다.
export function openTab(l: Layout, leafId: string, tab: Omit<Tab, "id"> & { id?: string }): Layout {
    const leaf = findLeaf(l, leafId);
    if (!leaf) return l;
    const existing = leaf.tabs.find((t) => sameResource(t, tab as Tab));
    if (existing) {
        return { ...l, root: mapLeaf(l.root, leafId, (x) => ({ ...(x as Leaf), active_tab: existing.id })), focused_leaf: leafId };
    }
    if (allTabs(l).length >= MAX_TABS) return l;
    const t: Tab = { ...tab, id: tab.id ?? uid("t") } as Tab;
    return { ...l, root: mapLeaf(l.root, leafId, (x) => ({ ...(x as Leaf), tabs: [...(x as Leaf).tabs, t], active_tab: t.id })), focused_leaf: leafId };
}

/// 기본 열기는 현재 pane의 사본을 우선하고 다른 pane에 있으면 그 탭으로 이동한다.
/// 명시적인 분할은 splitLeaf를 사용하므로 같은 자원의 독립 사본을 만들 수 있다.
export function openResource(l: Layout, tab: Omit<Tab, "id">): Layout {
    const here = focusedLeaf(l);
    for (const leaf of [here, ...leaves(l.root).filter((x) => x.id !== here.id)]) {
        const existing = leaf.tabs.find((t) => sameResource(t, tab as Tab));
        if (existing) return activate(l, existing.id);
    }
    return openTab(l, here.id, tab);
}

function depthOf(n: Node, id: string, d = 0): number {
    if (n.type === "leaf") return n.id === id ? d : -1;
    return Math.max(depthOf(n.children[0], id, d + 1), depthOf(n.children[1], id, d + 1));
}

/// pane 분할(좌우=row, 위아래=column). 새 pane에 tab을 열고 포커스를 옮긴다.
export function splitLeaf(l: Layout, leafId: string, direction: "row" | "column", tab?: Omit<Tab, "id">): Layout {
    if (leaves(l.root).length >= MAX_LEAVES || depthOf(l.root, leafId) >= MAX_DEPTH) return l;
    const nid = uid("L");
    const newLeaf: Leaf = { type: "leaf", id: nid, tabs: [], active_tab: null };
    const root = mapLeaf(l.root, leafId, (x) => ({ type: "split", direction, ratio: 0.5, children: [x, newLeaf] }));
    let next: Layout = { ...l, root, focused_leaf: nid };
    if (tab) next = openTab(next, nid, tab);
    return next;
}

/// tab을 다른 pane으로 이동(PANE-004). 원래 pane이 비면 닫고 형제를 승격한다.
export function moveTab(l: Layout, tabId: string, toLeafId: string): Layout {
    const from = leaves(l.root).find((x) => x.tabs.some((t) => t.id === tabId));
    const to = findLeaf(l, toLeafId);
    if (!from || !to || from.id === to.id) return l;
    const tab = from.tabs.find((t) => t.id === tabId)!;
    let root = mapLeaf(l.root, from.id, (x) => removeFromLeaf(x as Leaf, tabId));
    root = mapLeaf(root, toLeafId, (x) => ({ ...(x as Leaf), tabs: [...(x as Leaf).tabs, tab], active_tab: tab.id }));
    return collapseEmpty({ ...l, root, focused_leaf: toLeafId });
}

/// drop 위치(LAYOUT-004·PANE-004). center는 그 pane에 넣고, 가장자리는 대상 pane을 그 방향으로 나눈다.
export type DropEdge = "center" | "left" | "right" | "top" | "bottom";
export const SPLIT_EDGES = ["left", "right", "top", "bottom"] as const;
const EDGE: Record<(typeof SPLIT_EDGES)[number], { direction: "row" | "column"; before: boolean }> = {
    left: { direction: "row", before: true },
    right: { direction: "row", before: false },
    top: { direction: "column", before: true },
    bottom: { direction: "column", before: false },
};

export function canSplit(l: Layout, leafId: string): boolean {
    return leaves(l.root).length < MAX_LEAVES && depthOf(l.root, leafId) >= 0 && depthOf(l.root, leafId) < MAX_DEPTH;
}

function splitWith(root: Node, leafId: string, edge: (typeof SPLIT_EDGES)[number], added: Leaf): Node {
    const { direction, before } = EDGE[edge];
    return mapLeaf(root, leafId, (x) => ({ type: "split", direction, ratio: 0.5, children: before ? [added, x] : [x, added] }));
}

const clampIndex = (i: number | undefined, length: number) => Math.min(length, Math.max(0, i ?? length));

/// 기존 tab을 drop 위치로 옮긴다. tab ID를 유지하므로 초안·스크롤·서버 작업은 그대로다.
/// index는 옮길 tab을 뺀 나머지 목록에서의 위치다. 바꿀 수 없으면(한도·자기 자신 분할) 그대로 둔다.
export function placeTab(l: Layout, tabId: string, toLeafId: string, edge: DropEdge, index?: number): Layout {
    const from = leaves(l.root).find((x) => x.tabs.some((t) => t.id === tabId));
    const to = findLeaf(l, toLeafId);
    if (!from || !to) return l;
    const tab = from.tabs.find((t) => t.id === tabId)!;
    if (edge === "center") {
        const root = mapLeaf(l.root, from.id, (x) => removeFromLeaf(x as Leaf, tabId));
        const placed = mapLeaf(root, to.id, (x) => {
            const tabs = (x as Leaf).tabs;
            const at = clampIndex(index, tabs.length);
            return { ...(x as Leaf), tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], active_tab: tab.id };
        });
        return collapseEmpty({ ...l, root: placed, focused_leaf: to.id });
    }
    if ((from.id === to.id && from.tabs.length === 1) || !canSplit(l, to.id)) return l;
    const id = uid("L");
    const root = mapLeaf(l.root, from.id, (x) => removeFromLeaf(x as Leaf, tabId));
    return collapseEmpty({ ...l, root: splitWith(root, to.id, edge, { type: "leaf", id, tabs: [tab], active_tab: tab.id }), focused_leaf: id });
}

/// 최근 항목 등 새 자원을 drop 위치에 연다. center는 그 pane의 같은 자원을 재사용한다.
export function openAtEdge(l: Layout, toLeafId: string, edge: DropEdge, tab: Omit<Tab, "id">): Layout {
    if (!findLeaf(l, toLeafId)) return l;
    if (edge === "center") return openTab(l, toLeafId, tab);
    if (!canSplit(l, toLeafId) || allTabs(l).length >= MAX_TABS) return l;
    const id = uid("L");
    const next = { ...l, root: splitWith(l.root, toLeafId, edge, { type: "leaf", id, tabs: [], active_tab: null }), focused_leaf: id };
    return openTab(next, id, tab);
}

export const DRAG_TAB = "application/x-grove-tab";
export const DRAG_OPEN = "application/x-grove-open";
const DROP_KINDS: readonly TabKind[] = ["session", "project", "file", "terminal"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/// drag로 받은 열기 대상. 다른 페이지도 같은 형식을 흉내낼 수 있으므로 형식·길이를 검증하고 조회 탭만 만든다.
export function parseOpenTarget(raw: string): Omit<Tab, "id"> | null {
    let v: Record<string, unknown>;
    try {
        v = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!v || typeof v !== "object") return null;
    const { kind, project_id, resource_id, title, filePath } = v;
    if (!DROP_KINDS.includes(kind as TabKind) || typeof project_id !== "string" || !ID.test(project_id)) return null;
    if (typeof resource_id !== "string" || !resource_id || resource_id.length > 4096 || typeof title !== "string" || title.length > 500) return null;
    if (kind !== "file" && !ID.test(resource_id)) return null;
    if (filePath !== undefined && (kind !== "file" || typeof filePath !== "string" || filePath.length > 4096)) return null;
    return { kind: kind as TabKind, project_id, resource_id, title, ...(typeof filePath === "string" ? { filePath } : {}) };
}

function removeFromLeaf(leaf: Leaf, tabId: string): Leaf {
    const idx = leaf.tabs.findIndex((t) => t.id === tabId);
    const tabs = leaf.tabs.filter((t) => t.id !== tabId);
    let active = leaf.active_tab;
    if (active === tabId) active = tabs[Math.max(0, idx - 1)]?.id ?? null;
    return { ...leaf, tabs, active_tab: active };
}

/// tab 닫기. 화면만 닫으며 서버 작업은 계속된다(PANE-005).
export function closeTab(l: Layout, tabId: string): Layout {
    const leaf = leaves(l.root).find((x) => x.tabs.some((t) => t.id === tabId));
    if (!leaf) return l;
    return collapseEmpty({ ...l, root: mapLeaf(l.root, leaf.id, (x) => removeFromLeaf(x as Leaf, tabId)) });
}

/// 빈 pane을 제거하고 형제를 승격한다. 마지막 pane은 남긴다.
export function collapseEmpty(l: Layout): Layout {
    const go = (n: Node): Node | null => {
        if (n.type === "leaf") return n.tabs.length === 0 ? null : n;
        const a = go(n.children[0]);
        const b = go(n.children[1]);
        if (a && b) return { ...n, children: [a, b] };
        return a ?? b;
    };
    const root = go(l.root);
    if (!root) {
        const first = leaves(l.root)[0]!;
        return { ...l, root: { ...first, tabs: [], active_tab: null }, focused_leaf: first.id };
    }
    const ids = leaves(root).map((x) => x.id);
    return { ...l, root, focused_leaf: ids.includes(l.focused_leaf) ? l.focused_leaf : ids[0]! };
}

/// pane 닫기: 그 안의 tab을 인접 pane으로 합친다(tab 유실 방지, PANE-005).
export function closeLeaf(l: Layout, leafId: string): Layout {
    const leaf = findLeaf(l, leafId);
    if (!leaf) return l;
    // 가장 가까운 형제 subtree로 합친다. 자원이 같아도 tab ID와 독립 초안은 유지한다.
    const adjacent = (n: Node): Leaf | undefined => {
        if (n.type === "leaf") return undefined;
        if (n.children[0].type === "leaf" && n.children[0].id === leafId) return leaves(n.children[1])[0];
        if (n.children[1].type === "leaf" && n.children[1].id === leafId) return leaves(n.children[0])[0];
        return adjacent(n.children[0]) ?? adjacent(n.children[1]);
    };
    const target = adjacent(l.root);
    if (!target) return l;
    let root = mapLeaf(l.root, leafId, (x) => ({ ...x as Leaf, tabs: [], active_tab: null }));
    root = mapLeaf(root, target.id, (x) => ({
        ...x as Leaf, tabs: [...(x as Leaf).tabs, ...leaf.tabs], active_tab: leaf.active_tab ?? (x as Leaf).active_tab,
    }));
    return collapseEmpty({ ...l, root, focused_leaf: target.id });
}

/// path: 루트에서 split까지 children 인덱스 배열.
export function setRatio(l: Layout, path: number[], ratio: number): Layout {
    const r = Math.min(0.9, Math.max(0.1, ratio));
    const go = (n: Node, p: number[]): Node => {
        if (n.type !== "split") return n;
        if (p.length === 0) return { ...n, ratio: r };
        const [h, ...rest] = p;
        const children: [Node, Node] = [...n.children];
        children[h!] = go(children[h!]!, rest);
        return { ...n, children };
    };
    return { ...l, root: go(l.root, path) };
}

export function setDirection(l: Layout, path: number[], direction: "row" | "column"): Layout {
    const go = (n: Node, p: number[]): Node => {
        if (n.type !== "split") return n;
        if (p.length === 0) return { ...n, direction };
        const [h, ...rest] = p;
        const children: [Node, Node] = [...n.children];
        children[h!] = go(children[h!]!, rest);
        return { ...n, children };
    };
    return { ...l, root: go(l.root, path) };
}

export function focus(l: Layout, leafId: string): Layout {
    return findLeaf(l, leafId) ? { ...l, focused_leaf: leafId } : l;
}

export function activate(l: Layout, tabId: string): Layout {
    const leaf = leaves(l.root).find((x) => x.tabs.some((t) => t.id === tabId));
    if (!leaf) return l;
    return { ...l, root: mapLeaf(l.root, leaf.id, (x) => ({ ...(x as Leaf), active_tab: tabId })), focused_leaf: leaf.id };
}

/// 서버 규칙과 같은 검증. 잘못된 저장본은 복원하지 않고 기본 배치를 쓴다(PANE-008).
export function isValid(v: unknown): v is Layout {
    const l = v as Layout;
    if (!l || l.schema !== 1 || !l.root) return false;
    const ids = new Set<string>();
    let leafCount = 0;
    let tabCount = 0;
    const walk = (n: Node, d: number): boolean => {
        if (d > MAX_DEPTH) return false;
        if (n.type === "split") {
            if (n.direction !== "row" && n.direction !== "column") return false;
            if (!(n.ratio >= 0.1 && n.ratio <= 0.9)) return false;
            if (!Array.isArray(n.children) || n.children.length !== 2) return false;
            return walk(n.children[0], d + 1) && walk(n.children[1], d + 1);
        }
        if (n.type !== "leaf" || typeof n.id !== "string" || ids.has(n.id) || !Array.isArray(n.tabs)) return false;
        ids.add(n.id);
        leafCount++;
        for (const t of n.tabs) {
            tabCount++;
            if (typeof t.id !== "string" || ids.has("tab:" + t.id)) return false;
            ids.add("tab:" + t.id);
            if (t.kind !== "settings" && !t.project_id) return false;
        }
        if (n.active_tab && !n.tabs.some((t) => t.id === n.active_tab)) return false;
        return true;
    };
    return walk(l.root, 0) && leafCount <= MAX_LEAVES && tabCount <= MAX_TABS && ids.has(l.focused_leaf);
}

/// 사라진 자원(삭제·보관된 프로젝트 등)은 tab을 지우지 않고 missing 표시만 한다.
export function markMissing(l: Layout, exists: (t: Tab) => boolean): Set<string> {
    return new Set(allTabs(l).filter((t) => !exists(t)).map((t) => t.id));
}

/// 좁은 화면: 포커스된 pane의 활성 tab 하나만 보여 준다. 나머지 pane 상태는 보존된다(PANE-009).
export function mobileView(l: Layout): { leaf: Leaf; tab: Tab | undefined } {
    const leaf = focusedLeaf(l);
    return { leaf, tab: leaf.tabs.find((t) => t.id === leaf.active_tab) };
}
