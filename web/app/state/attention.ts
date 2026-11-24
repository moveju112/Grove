import { pushServerId } from "./webPush";
import type { EventRecord, Turn } from "../api/generated";
import { loadPrefs, type Prefs } from "./device";

// 화면을 보고 있지 않을 때 받은 이벤트를 기기 알림으로 표시한다.
export type AttentionKind = "done" | "failed" | "approval" | "server";
export type Attention = { kind: AttentionKind; tag: string; title: string; body: string; projectId: string | null; sessionId: string | null };

const OPEN_EVENT = "grove-open-session";
const CLAIM_KEY = "grove.attention.claims";
const CLAIM_TTL = 10 * 60_000;

export function attentionFor(e: EventRecord, p: Prefs): Attention | null {
    const base = { projectId: e.project_id, sessionId: e.session_id };
    if (e.kind === "turn.updated") {
        const t = e.payload as Partial<Turn>;
        if (!t?.id) return null;
        if (t.status === "awaiting_approval" && p.notifyApproval)
            return { ...base, kind: "approval", tag: `approval:${t.id}`, title: "승인 요청", body: "대화에서 도구 실행 승인을 기다립니다." };
        if (t.status === "completed" && p.notifyDone) return { ...base, kind: "done", tag: `turn:${t.id}`, title: "작업 완료", body: t.completion_preview?.trim() || "대화의 요청 처리가 끝났습니다." };
        if ((t.status === "failed" || t.status === "interrupted") && p.notifyDone)
            return { ...base, kind: "failed", tag: `turn:${t.id}`, title: "작업 실패", body: "대화의 요청 처리가 실패하거나 중단됐습니다." };
        return null;
    }
    if (e.kind === "notification.created" && p.notifyServer) {
        const n = e.payload as { id?: string; title?: string };
        if (!n?.id) return null;
        return { ...base, kind: "server", tag: `notification:${n.id}`, title: n.title || "알림", body: "Grove 알림을 확인하세요." };
    }
    return null;
}

/// 같은 브라우저의 여러 탭이 같은 사건을 받아도 한 번만 알린다(10분 보관).
export function claimAttention(tag: string, now: number, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): boolean {
    let claims: Record<string, number> = {};
    try {
        const parsed = JSON.parse(storage.getItem(CLAIM_KEY) ?? "{}") as unknown;
        if (parsed && typeof parsed === "object") claims = parsed as Record<string, number>;
    } catch {
        claims = {};
    }
    const fresh = Object.fromEntries(Object.entries(claims).filter(([, at]) => typeof at === "number" && now - at < CLAIM_TTL));
    if (tag in fresh) return false;
    fresh[tag] = now;
    storage.setItem(CLAIM_KEY, JSON.stringify(fresh));
    return true;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function playAttentionSound(): AudioContextState | "unsupported" {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return "unsupported";
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => void ctx.close();
    return ctx.state;
}

export async function showAttention(a: Attention, sound: boolean, vibrate = false): Promise<boolean> {
    if (sound) { try { playAttentionSound(); } catch { /* OS/browser may block audio until interaction. */ } }
    if (notificationPermission() !== "granted") {
        if (vibrate) navigator.vibrate?.([180, 80, 180]);
        return false;
    }
    try {
        const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL) : undefined;
        if (registration?.active) {
            const server = await pushServerId();
            const options: NotificationOptions & { vibrate: number[] } = {
                body: a.body, tag: `${server}:${a.tag}`, data: { projectId: a.projectId, sessionId: a.sessionId, server },
                vibrate: vibrate ? [180, 80, 180] : [],
            };
            await registration.showNotification(a.title, options);
            return true;
        }
        const n = new Notification(a.title, { body: a.body, tag: a.tag });
        if (vibrate) navigator.vibrate?.([180, 80, 180]);
        n.onclick = () => {
            window.focus();
            if (a.projectId && a.sessionId) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { projectId: a.projectId, sessionId: a.sessionId } }));
            n.close();
        };
        return true;
    } catch { return false; }
}

type RecentReadState = { kind?: unknown; resource_id?: unknown; unread?: unknown; completion_unread?: unknown };

function readSessionId(item: RecentReadState): string | null {
    return item?.kind === "session" && typeof item.resource_id === "string" && item.unread === false && item.completion_unread === false
        ? item.resource_id : null;
}

/// 이 기기 알림창에 남은 완료·실패 알림 중 읽은 대화의 것을 닫는다. 승인 요청 알림은 승인이 끝날 때까지 유지한다.
export async function closeReadNotifications(load: () => Promise<RecentReadState[]>): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (!registration) return;
    const server = await pushServerId();
    const shown = (await registration.getNotifications()).filter((n) => {
        const data = n.data as { sessionId?: unknown; server?: unknown } | null;
        return data?.server === server && typeof data.sessionId === "string" && n.tag.startsWith(`${server}:turn:`);
    });
    if (!shown.length) return;
    const read = new Set((await load()).map(readSessionId).filter((id) => id !== null));
    for (const n of shown) if (read.has((n.data as { sessionId: string }).sessionId)) n.close();
}

/// 앱을 열거나 다시 볼 때, 앱이 꺼져 있던 동안 다른 기기에서 읽은 대화의 알림도 정리한다.
export function watchReadNotifications(load: () => Promise<RecentReadState[]>): () => void {
    let active = true;
    const sweep = () => {
        if (active && document.visibilityState === "visible") void closeReadNotifications(load).catch(() => undefined);
    };
    sweep();
    document.addEventListener("visibilitychange", sweep);
    return () => { active = false; document.removeEventListener("visibilitychange", sweep); };
}

function watching(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
}

/// 이벤트 stream에서 호출한다. 사용자가 이 화면을 보고 있으면 알리지 않는다.
export function notifyAttention(e: EventRecord) {
    if (e.kind === "recent.updated") {
        const item = e.payload as RecentReadState;
        if (readSessionId(item)) void closeReadNotifications(async () => [item]).catch(() => undefined);
        return;
    }
    const prefs = loadPrefs();
    const a = attentionFor(e, prefs);
    if (!a || watching() || !claimAttention(a.tag, Date.now())) return;
    void showAttention(a, prefs.notifySound, prefs.notifyVibrate);
}

export function onOpenSession(open: (projectId: string, sessionId: string) => void): () => void {
    let active = true;
    const receive = async (d: { projectId?: string; sessionId?: string; server?: string }) => {
        if (typeof d?.projectId !== "string" || typeof d.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(d.projectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(d.sessionId)) return;
        if (d.server && d.server !== await pushServerId()) return;
        if (active) open(d.projectId, d.sessionId);
    };
    const handler = (e: Event) => { void receive((e as CustomEvent).detail); };
    const message = (e: MessageEvent) => { if (e.data?.type === "open-session") void receive(e.data); };
    window.addEventListener(OPEN_EVENT, handler);
    navigator.serviceWorker?.addEventListener("message", message);
    const url = new URL(location.href);
    if (url.searchParams.has("notify_session")) {
        void receive({ projectId: url.searchParams.get("notify_project") ?? undefined, sessionId: url.searchParams.get("notify_session") ?? undefined, server: url.searchParams.get("notify_server") ?? undefined });
        for (const name of ["notify_project", "notify_session", "notify_server"]) url.searchParams.delete(name);
        history.replaceState(history.state, "", url);
    }
    return () => { active = false; window.removeEventListener(OPEN_EVENT, handler); navigator.serviceWorker?.removeEventListener("message", message); };
}
