import { connection } from "./transport";

// 비밀이 아닌 요청 ID만 보관한다. 응답 유실·새로고침 뒤에도 같은 갱신 결과를 확인한다.
function scope() {
    return "grove.auth.refresh.v1:" + JSON.stringify(connection());
}

export function pendingRefreshKey(): string | null {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(scope());
}

export function refreshRequestKey(): string {
    const key = pendingRefreshKey() ?? crypto.randomUUID();
    if (typeof localStorage !== "undefined") localStorage.setItem(scope(), key);
    return key;
}

export function clearRefreshRequestKey(key: string) {
    if (typeof localStorage !== "undefined" && pendingRefreshKey() === key) localStorage.removeItem(scope());
}

// Web Locks 미지원 환경에서도 서버의 요청 ID별 재생이 중복 회전을 막는다.
export async function withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
        return await navigator.locks.request(scope(), operation);
    }
    return operation();
}
