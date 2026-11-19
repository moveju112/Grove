// CLI 명령 목록(/ 입력) 조회. 입력창을 쓰기 시작하면 미리 받아 두고, 일정 시간 안에는 다시 받지 않는다.
// 서버가 목록 변경 이벤트를 보내지 않으므로, 기간이 지난 뒤 "/"를 다시 입력하면 기존 목록을 보여 주면서 갱신한다.

import { useEffect, useRef } from "react";
import type { NativeCommandCatalog } from "../api/generated";
import { useQuery } from "./store";

/// 받은 목록을 다시 쓰는 기간.
export const NATIVE_COMMANDS_TTL_MS = 60_000;
const fetchedAt = new Map<string, number>();

/// "/" 입력을 시작했을 때 기존 목록을 다시 받아야 하는지. 첫 조회 중(기록 없음)에는 중복 요청하지 않는다.
export function nativeCommandsNeedRefresh(at: number | undefined, failed: boolean, now: number, ttl = NATIVE_COMMANDS_TTL_MS) {
    return failed || (at !== undefined && now - at >= ttl);
}

export function useNativeCommandCatalog(key: string | null, warm: boolean, slash: boolean, fetch: () => Promise<NativeCommandCatalog>) {
    const query = useQuery<NativeCommandCatalog>(key && (warm || slash) ? key : null, async () => {
        const result = await fetch();
        fetchedAt.set(key!, Date.now());
        return result;
    });
    const wasSlash = useRef(false);
    useEffect(() => {
        const entering = slash && !wasSlash.current;
        wasSlash.current = slash;
        if (!entering || !key || query.loading) return;
        if (nativeCommandsNeedRefresh(fetchedAt.get(key), !!query.error, Date.now())) query.reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slash, key]);
    return query;
}
