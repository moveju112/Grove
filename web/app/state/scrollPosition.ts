// 읽던 위치(메시지 seq와 offset)만 보관하고 메시지 본문은 저장하지 않는다(RECENCY-004·007).
// 탭별 위치는 sessionStorage, 대화별 마지막 위치는 앱 종료·폰 process death 뒤에도 남도록 localStorage에 둔다.
// 대화별 위치는 최근 SESSION_LIMIT개만 보관하고 직접 로그아웃하면 다른 기기 사본과 함께 지운다(cleanup.ts).
export const SESSION_LIMIT = 200;
const SESSION_PREFIX = "grove.scroll.session.";
const INDEX_KEY = "grove.scroll.index";

export type ScrollPosition = {
    sessionId: string;
    timelineRevision: number;
    lastSeq: number;
    atBottom: boolean;
    anchorSeq: number | null;
    offset: number;
};

export function parseScrollPosition(raw: string | null, sessionId: string): ScrollPosition | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object") return null;
        const p = value as Record<string, unknown>;
        if (p.sessionId !== sessionId || !Number.isSafeInteger(p.timelineRevision) || Number(p.timelineRevision) < 0
            || !Number.isSafeInteger(p.lastSeq) || Number(p.lastSeq) < 0 || typeof p.atBottom !== "boolean"
            || typeof p.offset !== "number" || !Number.isFinite(p.offset)) return null;
        if (p.atBottom ? p.anchorSeq !== null : !Number.isSafeInteger(p.anchorSeq) || Number(p.anchorSeq) <= 0 || Number(p.anchorSeq) > Number(p.lastSeq)) return null;
        return p as ScrollPosition;
    } catch {
        return null;
    }
}

export function loadScrollPosition(tabId: string, sessionId: string): ScrollPosition | null {
    try {
        return parseScrollPosition(sessionStorage.getItem(`grove.scroll.${tabId}`), sessionId)
            ?? parseScrollPosition(localStorage.getItem(SESSION_PREFIX + sessionId), sessionId)
            // 이전 버전이 탭 수명 동안 남긴 대화별 위치.
            ?? parseScrollPosition(sessionStorage.getItem(SESSION_PREFIX + sessionId), sessionId);
    } catch {
        return null;
    }
}

function readIndex(): string[] {
    try {
        const v: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function saveScrollPosition(tabId: string, position: ScrollPosition) {
    const raw = JSON.stringify(position);
    sessionStorage.setItem(`grove.scroll.${tabId}`, raw);
    // 최근에 본 대화를 앞에 두고 상한을 넘는 오래된 위치는 지운다.
    const index = [position.sessionId, ...readIndex().filter((id) => id !== position.sessionId)];
    for (const old of index.splice(SESSION_LIMIT)) localStorage.removeItem(SESSION_PREFIX + old);
    try {
        localStorage.setItem(SESSION_PREFIX + position.sessionId, raw);
        localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
        // 기기 저장 공간이 부족하면 탭 위치(sessionStorage)만 남는다. 위치는 편의 정보라 작업을 막지 않는다.
    }
}
