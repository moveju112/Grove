// 탭별 읽던 위치만 보관한다. 메시지 본문은 저장하지 않고 인증 종료 시 sessionStorage와 함께 지워진다.
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
        return parseScrollPosition(sessionStorage.getItem(`grove.scroll.${tabId}`), sessionId);
    } catch {
        return null;
    }
}

export function saveScrollPosition(tabId: string, position: ScrollPosition) {
    sessionStorage.setItem(`grove.scroll.${tabId}`, JSON.stringify(position));
}
