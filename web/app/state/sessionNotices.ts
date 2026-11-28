import { useSyncExternalStore } from "react";

// 보고 있는 화면에서 다른 대화의 새 질문·답변 완료를 상단 배너로 알린다. 기기 알림과 달리 이 탭에만 둔다.
export type SessionNotice = { id: string; kind: "question" | "done"; projectId: string; sessionId: string; text: string };

const LIMIT = 3;
const EMPTY: SessionNotice[] = [];
let notices: SessionNotice[] = EMPTY;
const listeners = new Set<() => void>();

function publish(next: SessionNotice[]) {
    notices = next;
    for (const listener of listeners) listener();
}

/// 같은 대화의 같은 종류는 최신 하나만 둔다.
export function showSessionNotice(notice: SessionNotice) {
    publish([...notices.filter((n) => n.id !== notice.id && (n.kind !== notice.kind || n.sessionId !== notice.sessionId)), notice].slice(-LIMIT));
}

export function dismissSessionNotice(id: string) {
    if (notices.some((n) => n.id === id)) publish(notices.filter((n) => n.id !== id));
}

/// 읽은 대화의 완료 알림을 지운다.
export function dismissDoneNotice(sessionId: string) {
    if (notices.some((n) => n.kind === "done" && n.sessionId === sessionId)) publish(notices.filter((n) => n.kind !== "done" || n.sessionId !== sessionId));
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useSessionNotices(): SessionNotice[] {
    return useSyncExternalStore(subscribe, () => notices, () => EMPTY);
}
