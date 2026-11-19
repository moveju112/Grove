// 최근 본 본문(파일·작업 출력·변경 diff)의 메모리 cache.
// 다시 열 때 이전 본문을 바로 보여 주고, 호출부는 같은 시점에 서버 조회를 시작해 최신 응답으로 교체한다(stale-while-revalidate).
// 바이트·항목 수 상한을 넘으면 가장 오래 쓰지 않은 항목부터 버린다. 인증 세대가 바뀌면 이전 항목을 돌려주지 않는다.

import { authGeneration } from "../api/client";

type Item<T> = { value: T; bytes: number; owner: number };

export type ContentCache<T> = {
    /// 현재 인증 세대의 항목만 돌려주고 최근 사용으로 표시한다.
    get(key: string): T | undefined;
    /// owner는 조회를 시작할 때의 인증 세대다. 그 사이 세대가 바뀌었으면 저장하지 않는다.
    set(key: string, value: T, owner?: number): void;
    delete(key: string): void;
    clear(): void;
    stats(): { entries: number; bytes: number };
};

const caches = new Set<{ clear(): void }>();

/// 로그아웃·만료 정리에서 모든 본문 cache를 비운다.
export function clearContentCaches() {
    for (const cache of caches) cache.clear();
}

/// 문자열 본문의 대략적인 메모리 크기(UTF-16).
export function textBytes(...texts: (string | null | undefined)[]): number {
    return texts.reduce((n, t) => n + (t?.length ?? 0) * 2, 64);
}

export function createContentCache<T>(options: {
    maxBytes: number; maxEntries: number; size: (value: T) => number; owner?: () => number;
}): ContentCache<T> {
    const owner = options.owner ?? authGeneration;
    // Map의 삽입 순서를 사용 순서로 쓴다. 앞쪽이 가장 오래 쓰지 않은 항목이다.
    const items = new Map<string, Item<T>>();
    let bytes = 0;
    const remove = (key: string) => {
        const item = items.get(key);
        if (!item) return;
        bytes -= item.bytes;
        items.delete(key);
    };
    const cache: ContentCache<T> = {
        get(key) {
            const item = items.get(key);
            if (!item) return undefined;
            if (item.owner !== owner()) { remove(key); return undefined; }
            items.delete(key);
            items.set(key, item);
            return item.value;
        },
        set(key, value, at = owner()) {
            remove(key);
            if (at !== owner()) return;
            const size = options.size(value);
            // 한 항목이 상한을 넘으면 보관하지 않는다. 다음에 열 때 서버 응답을 기다린다.
            if (size > options.maxBytes) return;
            items.set(key, { value, bytes: size, owner: at });
            bytes += size;
            for (const k of items.keys()) {
                if (bytes <= options.maxBytes && items.size <= options.maxEntries) break;
                remove(k);
            }
        },
        delete: remove,
        clear() { items.clear(); bytes = 0; },
        stats: () => ({ entries: items.size, bytes }),
    };
    caches.add(cache);
    return cache;
}
