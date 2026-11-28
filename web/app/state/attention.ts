import { pushServerId } from "./webPush";
import type { EventRecord, Turn } from "../api/generated";
import { loadPrefs, type Prefs } from "./device";
import { dismissDoneNotice, dismissSessionNotice, showSessionNotice, type SessionNotice } from "./sessionNotices";

// 화면을 보고 있지 않을 때 받은 이벤트를 기기 알림으로 표시한다.
export type AttentionKind = "done" | "failed" | "approval" | "question" | "server";
export type Attention = { kind: AttentionKind; tag: string; title: string; body: string; projectId: string | null; sessionId: string | null };

const OPEN_EVENT = "grove-open-session";
const CLAIM_KEY = "grove.attention.claims";
const CLAIM_TTL = 10 * 60_000;

// 종류마다 기기 알림을 켜는 설정과, 보고 있는 화면에 띄우는 상단 배너(종류·표시 시간 설정).
const DEVICE_PREF = {
    done: "notifyDone", failed: "notifyDone", approval: "notifyApproval", question: "notifyApproval", server: "notifyServer",
} as const satisfies Record<AttentionKind, keyof Prefs>;
const TOP_NOTICE: Partial<Record<AttentionKind, { kind: SessionNotice["kind"]; seconds: "noticeQuestionSeconds" | "noticeDoneSeconds" }>> = {
    question: { kind: "question", seconds: "noticeQuestionSeconds" },
    done: { kind: "done", seconds: "noticeDoneSeconds" },
};

/// 켜 둔 종류의 기기 알림만 돌려준다.
export function attentionFor(e: EventRecord, p: Prefs): Attention | null {
    const a = describeAttention(e);
    return a && p[DEVICE_PREF[a.kind]] ? a : null;
}

function describeAttention(e: EventRecord): Attention | null {
    const base = { projectId: e.project_id, sessionId: e.session_id };
    if (e.kind === "turn.updated") {
        const t = e.payload as Partial<Turn>;
        if (!t?.id) return null;
        if (t.status === "awaiting_approval")
            return { ...base, kind: "approval", tag: `approval:${t.id}`, title: "승인 요청", body: "대화에서 도구 실행 승인을 기다립니다." };
        if (t.status === "completed") return { ...base, kind: "done", tag: `turn:${t.id}`, title: "작업 완료", body: t.completion_preview?.trim() || "대화의 요청 처리가 끝났습니다." };
        if (t.status === "failed" || t.status === "interrupted")
            return { ...base, kind: "failed", tag: `turn:${t.id}`, title: "작업 실패", body: "대화의 요청 처리가 실패하거나 중단됐습니다." };
        return null;
    }
    if (e.kind === "tool_call.updated") {
        const call = questionCall(e);
        if (!call || call.status !== "awaiting_input") return null;
        const question = typeof call.target?.question === "string" ? call.target.question.trim().slice(0, 120) : "";
        return { ...base, kind: "question", tag: `question:${call.id}`, title: "질문", body: question || "대화에서 답을 기다립니다." };
    }
    if (e.kind === "notification.created") {
        const n = e.payload as { id?: string; title?: string };
        if (!n?.id) return null;
        return { ...base, kind: "server", tag: `notification:${n.id}`, title: n.title || "알림", body: "Grove 알림을 확인하세요." };
    }
    return null;
}

type QuestionCall = { id: string; turn_id?: string | null; status?: string; target?: { question?: unknown } };

function questionCall(e: EventRecord): QuestionCall | null {
    const call = e.payload as Partial<QuestionCall> & { name?: unknown } | null;
    return call?.name === "ask_user" && typeof call.id === "string" ? call as QuestionCall : null;
}

/// 답했거나 닫힌 질문의 알림을 이 기기 알림창에서 지운다.
async function closeQuestionNotification(id: string): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (!registration) return;
    const tag = `${await pushServerId()}:question:${id}`;
    for (const n of await registration.getNotifications({ tag })) n.close();
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
            if (a.projectId && a.sessionId) requestOpenSession(a.projectId, a.sessionId);
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

/// 그 대화가 지금 화면 어딘가에 열려 있으면 질문 카드가 이미 보인다.
function sessionShown(id: string): boolean {
    for (const view of document.querySelectorAll<HTMLElement>('[data-testid="session-view"]')) {
        if (view.dataset.session !== id) continue;
        const r = view.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth) return true;
    }
    return false;
}

/// 알림·배너에서 대화를 연다. Workspace가 onOpenSession으로 받는다.
export function requestOpenSession(projectId: string, sessionId: string) {
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { projectId, sessionId } }));
}

/// 이벤트 stream에서 호출한다. 사용자가 이 화면을 보고 있으면 알리지 않는다.
export function notifyAttention(e: EventRecord) {
    if (e.kind === "recent.updated") {
        const item = e.payload as RecentReadState;
        const read = readSessionId(item);
        if (read) {
            dismissDoneNotice(read);
            void closeReadNotifications(async () => [item]).catch(() => undefined);
        }
        return;
    }
    const call = e.kind === "tool_call.updated" ? questionCall(e) : null;
    if (call && call.status !== "awaiting_input") {
        dismissSessionNotice(`question:${call.id}`);
        void closeQuestionNotification(call.id).catch(() => undefined);
        return;
    }
    // 질문으로 턴이 사용자 대기로 바뀌면 같은 사건을 "승인 요청"으로 한 번 더 알리지 않는다.
    if (call?.turn_id) claimAttention(`approval:${call.turn_id}`, Date.now());
    const prefs = loadPrefs();
    const a = describeAttention(e);
    if (!a) return;
    if (watching()) {
        // 보고 있는 화면에서는 기기 알림 대신 상단 배너로 질문·답변 완료를 알린다. 그 대화를 열어 두었으면 생략한다.
        const top = TOP_NOTICE[a.kind];
        if (top && prefs[top.seconds] && a.projectId && a.sessionId && !sessionShown(a.sessionId) && claimAttention(a.tag, Date.now()))
            showSessionNotice({ id: a.tag, kind: top.kind, projectId: a.projectId, sessionId: a.sessionId, text: a.body });
        return;
    }
    if (!prefs[DEVICE_PREF[a.kind]] || !claimAttention(a.tag, Date.now())) return;
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
