// 보내기를 누른 요청만 보관한다. 작성 중인 입력·첨부는 저장하지 않는다.
import { EFFORTS, sendOptionsSignature, type FollowKind, type SendOptions } from "./sendOptions";

export type Attachment = { id: string; project_id: string; name: string; mime: string; size: number; stored: boolean; image?: { width: number; height: number; model_width: number; model_height: number } | null };
export type MissingUpload = { index: number; name: string; size: number };
export type PendingSend = { body: string; raw: string; sig: string; key: string; intent: SendOptions; options: SendOptions; attachmentIds: string[]; attachments: Attachment[]; missing?: MissingUpload[]; follow?: FollowKind };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type Recovery = { pending: PendingSend | null; invalid: boolean };
const prefix = (resource: string) => `grove.send.${resource}#`;
const key = (resource: string, copy: string) => prefix(resource) + copy;

export function parseAttachments(value: unknown): Attachment[] {
    if (!Array.isArray(value)) return [];
    return value.filter((a): a is Attachment => a && typeof a.id === "string" && typeof a.project_id === "string"
        && typeof a.name === "string" && typeof a.mime === "string" && typeof a.stored === "boolean"
        && Number.isFinite(a.size) && a.size >= 0).slice(0, 8);
}

export function validSendOptions(o: SendOptions | undefined): o is SendOptions {
    return !!o && ["model", "save"].includes(o.mode) && (o.profileId === null || typeof o.profileId === "string")
        && (o.agentId === null || typeof o.agentId === "string") && (o.tools === undefined || typeof o.tools === "boolean")
        && (o.toolOverride === undefined || typeof o.toolOverride === "boolean")
        && (o.effort === undefined || EFFORTS.includes(o.effort))
        && (o.serviceTier == null || (typeof o.serviceTier === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(o.serviceTier)))
        && (o.nativeCommand === undefined || (typeof o.nativeCommand === "string" && /^cmd_[a-f0-9]{64}$/.test(o.nativeCommand)))
        && (o.model == null || (typeof o.model === "string" && o.model.length > 0 && o.model.length <= 200 && !/\s/.test(o.model)));
}

function parse(raw: string): PendingSend | null {
    try {
        const p = JSON.parse(raw) as PendingSend;
        return p && typeof p.raw === "string" && typeof p.body === "string" && typeof p.key === "string" && !!p.key
            && validSendOptions(p.intent) && validSendOptions(p.options) && Array.isArray(p.attachmentIds)
            && p.attachmentIds.length <= 8 && p.attachmentIds.every((id) => typeof id === "string")
            && (p.missing === undefined || (Array.isArray(p.missing) && p.missing.length > 0
                && p.missing.length + p.attachmentIds.length <= 8
                && p.missing.every((m, i) => m && typeof m.name === "string" && Number.isSafeInteger(m.size) && m.size >= 0
                    && Number.isInteger(m.index) && m.index >= i && m.index < p.attachmentIds.length + p.missing!.length
                    && (i === 0 || p.missing![i - 1]!.index < m.index))))
            && (p.follow === undefined || ["queue", "steer", "interrupt"].includes(p.follow))
            && p.sig === sendOptionsSignature(p.intent, p.attachmentIds)
            ? { ...p, attachments: parseAttachments(p.attachments) } : null;
    } catch { return null; }
}

export function loadRecovery(store: Store | null, resource: string, copy: string): Recovery {
    if (!store) return { pending: null, invalid: false };
    try {
        const own = store.getItem(key(resource, copy));
        if (own !== null) {
            const pending = parse(own);
            return { pending, invalid: !pending };
        }
        // 닫힌 화면에서 이미 보낸 요청도 새 화면에서 같은 키로 확인한다.
        for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (!k?.startsWith(prefix(resource))) continue;
            const pending = parse(store.getItem(k)!);
            return { pending, invalid: !pending };
        }
        return { pending: null, invalid: false };
    } catch { return { pending: null, invalid: true }; }
}

export function saveRecovery(store: Store, resource: string, copy: string, pending: PendingSend): void {
    store.setItem(key(resource, copy), JSON.stringify(pending));
}

export function settleRecovery(store: Store, resource: string, requestKey: string): void {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(prefix(resource)) && parse(store.getItem(k)!)?.key === requestKey) keys.push(k);
    }
    keys.forEach((k) => store.removeItem(k));
}

export function clearInvalidRecovery(store: Store, resource: string): void {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(prefix(resource)) && !parse(store.getItem(k)!)) keys.push(k);
    }
    keys.forEach((k) => store.removeItem(k));
}
