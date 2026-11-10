// PWA: service worker 등록과 사용자 선택 후 업데이트(FLOW-16).
// 새 버전이 대기 중이면 배너만 보이고, 사용자가 누를 때만 전환한다(입력 중 강제 reload 없음).

import { useSyncExternalStore } from "react";
import { onProtocolMismatch } from "../api/client";

let waiting: ServiceWorker | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
        const check = (w: ServiceWorker | null) => {
            if (w && navigator.serviceWorker.controller) {
                waiting = w;
                emit();
            }
        };
        check(reg.waiting);
        reg.addEventListener("updatefound", () => {
            const w = reg.installing;
            w?.addEventListener("statechange", () => {
                if (w.state === "installed") check(w);
            });
        });
        // 주기적으로 새 버전 확인(작업 중에도 확인만 하고 적용하지 않음)
        setInterval(() => void reg.update().catch(() => undefined), 30 * 60 * 1000);
    });
    // 첫 설치 때도 clients.claim()으로 controllerchange가 일어난다. 그때 reload하면 입력 중인 값이 사라지므로
    // 사용자가 업데이트를 고른 경우에만 다시 불러온다.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!updateRequested || reloaded) return;
        reloaded = true;
        location.reload();
    });
}

let updateRequested = false;
let reloaded = false;

export function applyUpdate() {
    // 초안은 입력할 때마다 localStorage에 저장되어 있으므로 reload 후 복원된다.
    updateRequested = true;
    waiting?.postMessage({ type: "skip-waiting" });
}

/// 서버 protocol이 이 화면과 다르면(서버만 먼저 업데이트된 오래 열린 탭) 변경 요청을 막고 새로고침을 안내한다.
export function ProtocolBanner() {
    const server = useSyncExternalStore(
        (cb) => onProtocolMismatch(() => cb()),
        () => currentMismatch(),
        () => null,
    );
    if (server === null) return null;
    return (
        <div className="update-banner error" role="alert" data-testid="protocol-banner">
            서버가 새 버전(protocol {server})으로 바뀌어 이 화면에서는 변경 요청을 보낼 수 없습니다. 입력 중인 초안은 보존됩니다.
            <button onClick={() => location.reload()}>새로고침</button>
        </div>
    );
}

let mismatchSnapshot: number | null = null;
onProtocolMismatch((s) => {
    mismatchSnapshot = s;
});
function currentMismatch() {
    return mismatchSnapshot;
}

export function UpdateBanner() {
    const w = useSyncExternalStore(
        (cb) => {
            subs.add(cb);
            return () => subs.delete(cb);
        },
        () => waiting,
        () => null,
    );
    if (!w) return null;
    return (
        <div className="update-banner" role="status">
            새 버전이 준비되었습니다. 입력 중인 초안은 보존됩니다.
            <button onClick={applyUpdate}>지금 업데이트</button>
            <button className="ghost" onClick={() => { waiting = null; emit(); }}>나중에</button>
        </div>
    );
}
