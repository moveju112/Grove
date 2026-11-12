import type { EventRecord } from "../api/generated";
import { loadPrefs, type Prefs } from "./device";

// 화면을 보고 있지 않을 때 이 기기에서 알리는 사건(SETTINGS-014). 서버 영속 알림·Push와는 별개이며
// 앱이 열린 뒤 받은 이벤트만 다룬다. 잠금 화면 노출을 막기 위해 대화 내용은 넣지 않는다.
export type AttentionKind = "done" | "failed" | "approval" | "server";
export type Attention = { kind: AttentionKind; tag: string; title: string; body: string; projectId: string | null; sessionId: string | null };

const OPEN_EVENT = "grove-open-session";
const CLAIM_KEY = "grove.attention.claims";
const CLAIM_TTL = 10 * 60_000;

export function attentionFor(e: EventRecord, p: Prefs): Attention | null {
    const base = { projectId: e.project_id, sessionId: e.session_id };
    if (e.kind === "turn.updated") {
        const t = e.payload as { id?: string; status?: string };
        if (!t?.id) return null;
        if (t.status === "awaiting_approval" && p.notifyApproval)
            return { ...base, kind: "approval", tag: `approval:${t.id}`, title: "승인 요청", body: "대화에서 도구 실행 승인을 기다립니다." };
        if (t.status === "completed" && p.notifyDone) return { ...base, kind: "done", tag: `turn:${t.id}`, title: "작업 완료", body: "대화의 요청 처리가 끝났습니다." };
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

function beep() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => void ctx.close();
}

export function showAttention(a: Attention, sound: boolean) {
    if (sound) beep();
    if (notificationPermission() !== "granted") return;
    const n = new Notification(a.title, { body: a.body, tag: a.tag });
    n.onclick = () => {
        window.focus();
        if (a.projectId && a.sessionId) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { projectId: a.projectId, sessionId: a.sessionId } }));
        n.close();
    };
}

function watching(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
}

/// 이벤트 stream에서 호출한다. 사용자가 이 화면을 보고 있으면 알리지 않는다.
export function notifyAttention(e: EventRecord) {
    const prefs = loadPrefs();
    const a = attentionFor(e, prefs);
    if (!a || watching() || !claimAttention(a.tag, Date.now())) return;
    showAttention(a, prefs.notifySound);
}

export function onOpenSession(open: (projectId: string, sessionId: string) => void): () => void {
    const handler = (e: Event) => {
        const d = (e as CustomEvent<{ projectId: string; sessionId: string }>).detail;
        if (d?.projectId && d.sessionId) open(d.projectId, d.sessionId);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
}
