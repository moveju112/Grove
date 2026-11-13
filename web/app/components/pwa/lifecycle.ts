import { useSyncExternalStore } from "react";
import { ApiError, PROTOCOL, checkProtocol, onProtocolMismatch } from "../../api/client";

export type StorageIssue = "quota" | "unavailable" | "missing" | null;
export type LifecycleState = {
    online: boolean;
    connection: "checking" | "ready" | "unreachable";
    protocol: number | null;
    storageIssue: StorageIssue;
    storageApi: "unknown" | "supported" | "unsupported" | "unavailable";
    persistence: "unknown" | "persistent" | "best-effort";
    shell: "unknown" | "ready" | "missing" | "unsupported";
};

const initial: LifecycleState = {
    online: true, connection: "checking", protocol: null, storageIssue: null,
    storageApi: "unknown", persistence: "unknown", shell: "unknown",
};
let state = initial;
const subscribers = new Set<() => void>();
function update(patch: Partial<LifecycleState>) {
    if (Object.entries(patch).every(([key, value]) => state[key as keyof LifecycleState] === value)) return;
    state = { ...state, ...patch };
    subscribers.forEach((notify) => notify());
}
onProtocolMismatch((protocol) => update({ protocol }));

export function serverBlockReason(value: LifecycleState): string | null {
    if (!value.online) return "오프라인에서는 초안만 작성할 수 있습니다. 전송·승인·도구 실행은 연결 후 직접 다시 시도하세요.";
    if (value.protocol !== null) return `서버 protocol ${value.protocol}과 화면 protocol ${PROTOCOL}이 달라 요청을 보낼 수 없습니다. UI를 업데이트하세요.`;
    if (value.connection === "checking") return "서버 호환성을 확인하고 있습니다. 초안은 계속 작성할 수 있습니다.";
    if (value.connection === "unreachable") return "서버에 연결할 수 없어 전송할 수 없습니다. 초안은 계속 작성할 수 있습니다.";
    return null;
}

export function useLifecycle() {
    return useSyncExternalStore(
        (notify) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
        lifecycleSnapshot,
        () => initial,
    );
}

export function lifecycleSnapshot(): LifecycleState { return state; }

/** 승인·도구 실행 등 다른 서버 작업도 같은 이유를 disabled와 실행 직전 검사에 사용한다. */
export function useServerBlockReason() {
    return serverBlockReason(useLifecycle());
}

export function requireServerAction() {
    // offline 이벤트/React 렌더보다 먼저 단축키가 들어와도 전송하지 않는다.
    const reason = serverBlockReason({ ...state, online: state.online && navigator.onLine });
    if (reason) throw new ApiError(state.protocol !== null ? 409 : 0,
        !navigator.onLine ? "offline" : state.protocol !== null ? "protocol_mismatch" : "server_unavailable",
        reason, false, { result_unknown: false });
}

export function storageFailure(error: unknown): Exclude<StorageIssue, null | "missing"> {
    const name = (error as { name?: unknown } | null)?.name;
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" ? "quota" : "unavailable";
}

const MARKER = "grove.pwa.storage-seen";
let seenStorage = false;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
let draftStorage: DraftStorage | null = null;

/** 기존 초안 구현에 주입하는 대역. 원본 Storage와 오류를 그대로 유지하며 실패만 안내에 반영한다. */
export function localDraftStorage(): DraftStorage | null {
    if (typeof window === "undefined") return null;
    if (draftStorage) return draftStorage;
    try {
        const storage = window.localStorage;
        const observe = <T>(operation: () => T): T => {
            try { return operation(); }
            catch (error) { update({ storageIssue: storageFailure(error) }); throw error; }
        };
        draftStorage = {
            get length() { return observe(() => storage.length); },
            key: (index) => observe(() => storage.key(index)),
            getItem: (key) => observe(() => storage.getItem(key)),
            removeItem: (key) => observe(() => storage.removeItem(key)),
            setItem: (key, value) => observe(() => {
                // 저장 전에 감지해야 삭제된 초안이 새 입력으로 대체된 사실을 놓치지 않는다.
                inspectLocalStorage(storage);
                storage.setItem(key, value);
                if (key.startsWith("grove.draft.") && state.storageIssue === "quota") update({ storageIssue: null });
            }),
        };
        return draftStorage;
    } catch (error) {
        update({ storageIssue: storageFailure(error) });
        return null;
    }
}

function inspectLocalStorage(storage: Storage) {
    // sessionStorage까지 함께 지워진 뒤의 첫 방문과 eviction은 구분할 수 없다.
    // 관측한 유실만 알리고 원인이나 이전 초안의 복구 가능성을 단정하지 않는다.
    let seenInTab = false;
    try { seenInTab = sessionStorage.getItem(MARKER) === "1"; } catch { /* 메모리 표식으로만 감지 */ }
    if (storage.getItem(MARKER) === null && (seenStorage || seenInTab)) update({ storageIssue: "missing" });
    storage.setItem(MARKER, "1");
    seenStorage = true;
    try { sessionStorage.setItem(MARKER, "1"); } catch { /* 다른 탭/재시작 이후 감지에는 한계가 있음 */ }
}

export function inspectLocalDrafts() {
    try { inspectLocalStorage(window.localStorage); }
    catch (error) { update({ storageIssue: storageFailure(error) }); }
}

export async function inspectStoragePolicy() {
    if (!navigator.storage) {
        update({ storageApi: "unsupported", persistence: "unknown" });
        return;
    }
    try {
        const persistent = navigator.storage.persisted ? await navigator.storage.persisted() : null;
        update({ storageApi: "supported", persistence: persistent === null ? "unknown" : persistent ? "persistent" : "best-effort" });
    } catch {
        update({ storageApi: "unavailable", persistence: "unknown" });
    }
}

let checking: Promise<void> | null = null;
export function checkCompatibility(): Promise<void> {
    const reconnected = navigator.onLine && !state.online;
    update({ online: navigator.onLine, ...(reconnected ? { connection: "checking" as const } : {}) });
    if (!navigator.onLine) return Promise.resolve();
    if (checking) return checking;
    checking = (async () => {
        try {
            const response = await fetch("/api/v1/health", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
            checkProtocol(response);
            const health = await response.json() as { protocol?: unknown };
            if (!response.ok || !Number.isSafeInteger(health.protocol)) throw new Error("invalid health response");
            // health의 기존 protocol 필드를 재사용한다. 헤더를 제거하는 proxy도 불일치를 감지한다.
            checkProtocol(new Response(null, { headers: { "x-grove-protocol": String(health.protocol) } }));
            update({ connection: "ready" });
        } catch {
            update({ connection: "unreachable" });
        } finally { checking = null; }
    })();
    return checking;
}

/** root의 안내 mount가 소유한다. 네트워크 복구는 조회만 하며 작업을 재전송하지 않는다. */
export function startLifecycle(): () => void {
    let stopped = false;
    const inspect = () => {
        inspectLocalDrafts();
        void inspectStoragePolicy();
        if ("serviceWorker" in navigator) navigator.serviceWorker.controller?.postMessage({ type: "shell-status" });
        else update({ shell: "unsupported" });
    };
    const refresh = () => { if (!stopped) { inspect(); void checkCompatibility(); } };
    const visibility = () => { if (document.visibilityState === "visible") refresh(); };
    const offline = () => update({ online: false });
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === MARKER) inspectLocalDrafts(); };
    const message = (event: MessageEvent) => {
        if (event.source === navigator.serviceWorker.controller && event.data?.type === "shell-status" && typeof event.data.cached === "boolean") {
            update({ shell: event.data.cached ? "ready" : "missing" });
        }
    };
    window.addEventListener("online", refresh);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", visibility);
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", message);
        navigator.serviceWorker.addEventListener("controllerchange", inspect);
    }
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30_000);
    return () => {
        stopped = true;
        clearInterval(timer);
        window.removeEventListener("online", refresh);
        window.removeEventListener("offline", offline);
        window.removeEventListener("focus", refresh);
        window.removeEventListener("storage", storage);
        document.removeEventListener("visibilitychange", visibility);
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.removeEventListener("message", message);
            navigator.serviceWorker.removeEventListener("controllerchange", inspect);
        }
    };
}
