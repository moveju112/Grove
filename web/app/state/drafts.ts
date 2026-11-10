// 기기 내 초안 사본과 서버 초안의 충돌 판정(RECENCY-005, FLOW-12).
// 기기 내 사본은 자동 저장(localStorage)하고, 서버 저장은 사용자가 명시적으로 한다. 무음 덮어쓰기는 없다.

export type LocalDraft = { text: string; baseRevision: number; updatedAt: number };
export type ServerDraft = { text: string; revision: number; device_name: string; updated_at: string | null };

export type DraftState =
    | { kind: "empty" }
    | { kind: "in_sync" }
    | { kind: "local_only" } // 서버보다 앞선 로컬 수정(서버는 그대로)
    | { kind: "server_newer"; server: ServerDraft } // 로컬 수정 없음, 서버가 더 새로움 → 불러오기 가능
    | { kind: "conflict"; server: ServerDraft }; // 양쪽 모두 수정

export function compare(local: LocalDraft | null, server: ServerDraft): DraftState {
    if (!local || local.text === "") {
        if (server.revision === 0 || server.text === "") return { kind: "empty" };
        return { kind: "server_newer", server };
    }
    if (local.text === server.text) return { kind: "in_sync" };
    if (server.revision === local.baseRevision) return { kind: "local_only" };
    if (server.revision > local.baseRevision) return { kind: "conflict", server };
    return { kind: "local_only" };
}

export interface Store {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
}

const prefix = "grove.draft.";

/// 탭/분할 사본마다 다른 키를 쓸 수 있도록 copy 식별자를 붙인다.
export function key(resourceKey: string, copy?: string): string {
    return prefix + resourceKey + (copy ? "#" + copy : "");
}

export function load(store: Store, k: string): LocalDraft | null {
    try {
        const raw = store.getItem(k);
        if (!raw) return null;
        const v = JSON.parse(raw) as LocalDraft;
        return typeof v.text === "string" && typeof v.baseRevision === "number" ? v : null;
    } catch {
        return null;
    }
}

export function save(store: Store, k: string, d: LocalDraft): void {
    if (d.text === "") store.removeItem(k);
    else store.setItem(k, JSON.stringify(d));
}

/// 같은 자원의 여러 사본(탭/분할) 중 다른 사본과 내용이 다르면 알린다.
export function siblingCopies(store: Store & { length: number; key(i: number): string | null }, resourceKey: string): { key: string; draft: LocalDraft }[] {
    const out: { key: string; draft: LocalDraft }[] = [];
    for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || !(k === prefix + resourceKey || k.startsWith(prefix + resourceKey + "#"))) continue;
        const d = load(store, k);
        if (d && d.text) out.push({ key: k, draft: d });
    }
    return out;
}
