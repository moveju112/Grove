// 기기 내 초안 사본과 서버 초안의 충돌 판정(RECENCY-005, FLOW-12).
// 기기 내 사본은 자동 저장(localStorage)하고, 서버 저장은 사용자가 명시적으로 한다. 무음 덮어쓰기는 없다.

import { sendOptionsSignature, type FollowKind, type SendOptions } from "./sendOptions";

export type DraftAttachment = { id: string; project_id: string; name: string; mime: string; size: number; stored: boolean; image?: { width: number; height: number; model_width: number; model_height: number } | null };
export type PendingSend = { body: string; raw: string; sig: string; key: string; intent: SendOptions; options: SendOptions; attachmentIds: string[]; follow?: FollowKind };
export type LocalDraft = { text: string; baseRevision: number; updatedAt: number; attachments?: DraftAttachment[]; pending?: PendingSend; pendingInvalid?: boolean };
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

export function parseDraftAttachments(value: unknown): DraftAttachment[] {
    if (!Array.isArray(value)) return [];
    return value.filter((a): a is DraftAttachment => a && typeof a.id === "string" && typeof a.project_id === "string"
        && typeof a.name === "string" && typeof a.mime === "string" && typeof a.stored === "boolean"
        && Number.isFinite(a.size) && a.size >= 0).slice(0, 8);
}

function validOptions(o: SendOptions | undefined): boolean {
    return !!o && ["model", "save"].includes(o.mode) && (o.profileId === null || typeof o.profileId === "string")
        && (o.agentId === null || typeof o.agentId === "string") && typeof o.tools === "boolean"
        && (o.effort === undefined || ["auto", "low", "medium", "high"].includes(o.effort));
}

function validPending(p: PendingSend): boolean {
    return !!p && typeof p.raw === "string" && typeof p.body === "string" && typeof p.key === "string" && !!p.key
        && validOptions(p.intent) && validOptions(p.options) && Array.isArray(p.attachmentIds)
        && p.attachmentIds.length <= 8 && p.attachmentIds.every((id) => typeof id === "string")
        && (p.follow === undefined || ["queue", "steer", "interrupt"].includes(p.follow))
        && p.sig === sendOptionsSignature(p.intent, p.attachmentIds);
}

/// 탭/분할 사본마다 다른 키를 쓸 수 있도록 copy 식별자를 붙인다.
export function key(resourceKey: string, copy?: string): string {
    return prefix + resourceKey + (copy ? "#" + copy : "");
}

export function load(store: Store, k: string): LocalDraft | null {
    try {
        const raw = store.getItem(k);
        const legacy = () => parseDraftAttachments(JSON.parse(store.getItem(`${k}:attachments`) ?? "[]"));
        if (!raw) {
            const attachments = legacy();
            return attachments.length ? { text: "", baseRevision: 0, updatedAt: 0, attachments } : null;
        }
        const v = JSON.parse(raw) as LocalDraft;
        if (!v || typeof v.text !== "string" || !Number.isSafeInteger(v.baseRevision) || v.baseRevision < 0) return null;
        const pending = v.pending && validPending(v.pending) ? v.pending : undefined;
        return { ...v, attachments: store.getItem(`${k}:attachments`) !== null ? legacy() : parseDraftAttachments(v.attachments),
            pending, pendingInvalid: v.pendingInvalid === true || (!!v.pending && !pending) };
    } catch {
        return null;
    }
}

export function save(store: Store, k: string, d: LocalDraft): void {
    if (d.attachments !== undefined) store.setItem(`${k}:attachments`, JSON.stringify(d.attachments));
    if (d.text === "" && !d.attachments?.length && !d.pending && !d.pendingInvalid) store.removeItem(k);
    else store.setItem(k, JSON.stringify(d));
}

/// 같은 자원의 여러 사본(탭/분할) 중 다른 사본과 내용이 다르면 알린다.
export function siblingCopies(store: Store & { length: number; key(i: number): string | null }, resourceKey: string): { key: string; draft: LocalDraft }[] {
    const out: { key: string; draft: LocalDraft }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < store.length; i++) {
        const raw = store.key(i);
        const k = raw?.endsWith(":attachments") ? raw.slice(0, -":attachments".length) : raw;
        if (!k || !(k === prefix + resourceKey || k.startsWith(prefix + resourceKey + "#"))) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        const d = load(store, k);
        if (d && (d.text || d.attachments?.length || d.pending || d.pendingInvalid)) out.push({ key: k, draft: d });
    }
    return out.sort((a, b) => b.draft.updatedAt - a.draft.updatedAt);
}

// 같은 요청을 이어받은 사본도 함께 정리하되, 이후 입력·새 첨부·다른 요청은 보존한다.
export function settleSend(store: Store & { length: number; key(i: number): string | null }, resourceKey: string, requestKey: string, accepted: boolean): void {
    for (const copy of siblingCopies(store, resourceKey)) {
        const p = copy.draft.pending;
        if (p?.key !== requestKey) continue;
        save(store, copy.key, {
            ...copy.draft, pending: undefined,
            text: accepted && copy.draft.text === p.raw ? "" : copy.draft.text,
            attachments: accepted ? copy.draft.attachments?.filter((a) => !p.attachmentIds.includes(a.id)) : copy.draft.attachments,
        });
    }
}
