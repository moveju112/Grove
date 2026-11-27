import { useSyncExternalStore } from "react";

// 보고 있는 화면에서 새로 온 질문을 상단 배너로 알린다. 기기 알림과 달리 이 탭에만 둔다.
export type QuestionNotice = { id: string; projectId: string; sessionId: string; text: string };

const LIMIT = 3;
const EMPTY: QuestionNotice[] = [];
let notices: QuestionNotice[] = EMPTY;
const listeners = new Set<() => void>();

function publish(next: QuestionNotice[]) {
    notices = next;
    for (const listener of listeners) listener();
}

export function showQuestionNotice(notice: QuestionNotice) {
    publish([...notices.filter((n) => n.id !== notice.id), notice].slice(-LIMIT));
}

export function dismissQuestionNotice(id: string) {
    if (notices.some((n) => n.id === id)) publish(notices.filter((n) => n.id !== id));
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useQuestionNotices(): QuestionNotice[] {
    return useSyncExternalStore(subscribe, () => notices, () => EMPTY);
}
