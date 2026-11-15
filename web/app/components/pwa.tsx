import { Text as GroveText } from "@astryxdesign/core/Text";
// 입력이 없는 탭은 새 버전을 바로 적용하고, 입력이 남은 탭은 사용자가 고를 때까지 기다린다.
import { useSyncExternalStore } from "react";
import { onProtocolMismatch } from "../api/client";
import { deployment } from "../deployment";
import { Button } from "../design/Button";
import { SentenceText } from "./HelpTip";
import { useLifecycle } from "./pwa/lifecycle";
import { hasPendingInput, trackPendingInput } from "./pwa/pendingInput";

let waiting: ServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let updateRequested = false;
let reloaded = false;
let snapshot: { worker: ServiceWorker | null; error: string | null } = { worker: null, error: null };
const subscribers = new Set<() => void>();
function publish(worker: ServiceWorker | null, error: string | null = null) {
    snapshot = { worker, error };
    subscribers.forEach((notify) => notify());
}
function checkWaiting(worker: ServiceWorker | null) {
    if (worker && navigator.serviceWorker.controller && worker !== waiting) {
        waiting = worker;
        if (navigator.onLine && !hasPendingInput()) applyUpdate();
        else publish(worker);
    }
}

export function registerServiceWorker() {
    if (started || !("serviceWorker" in navigator) || import.meta.env.DEV) return;
    started = true;
    trackPendingInput();
    let controller = navigator.serviceWorker.controller;
    // 첫 claim이나 다른 탭의 동의로 입력 중인 탭을 reload하지 않는다.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        const previous = controller;
        controller = navigator.serviceWorker.controller;
        if (!updateRequested && previous && controller && previous !== controller) checkWaiting(controller);
        if (!updateRequested || reloaded) return;
        reloaded = true;
        location.reload();
    });
    void navigator.serviceWorker.register(deployment.serviceWorker, {
        scope: deployment.serviceWorkerScope, updateViaCache: "none",
    }).then((reg) => {
        registration = reg;
        checkWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => {
            const worker = reg.installing;
            worker?.addEventListener("statechange", () => {
                if (worker.state === "installed") checkWaiting(worker);
                if (worker.state === "redundant") publish(snapshot.worker, "새 UI cache 설치에 실패했습니다. 현재 탭은 유지합니다. 입력을 복사하고 저장 공간·연결을 확인하세요.");
            });
        });
        setInterval(() => {
            if (navigator.onLine) void checkForUpdate();
        }, 30 * 60 * 1000);
    }).catch(() => {
        publish(null, "앱 cache를 등록하지 못했습니다. 오프라인 재실행을 보장할 수 없습니다. 연결과 브라우저 저장 설정을 확인하세요.");
    });
}

export async function checkForUpdate() {
    if (!registration) return;
    try {
        await registration.update();
        checkWaiting(registration.waiting);
        if (registration.waiting && !updateRequested) publish(registration.waiting);
    } catch {
        publish(snapshot.worker, "새 UI 확인에 실패했습니다. 현재 탭은 유지합니다. 연결과 브라우저 저장 공간을 확인하세요.");
    }
}

export function applyUpdate() {
    if (!waiting || updateRequested || !navigator.onLine) return;
    updateRequested = true;
    // 다른 탭에서 이미 활성화한 버전으로 넘어갈 때도 이 탭의 사용자 동의를 기다린다.
    if (waiting.state === "activated" || waiting.state === "redundant") {
        reloaded = true;
        location.reload();
        return;
    }
    waiting.postMessage({ type: "skip-waiting" });
}

let mismatchSnapshot: number | null = null;
onProtocolMismatch((server) => { mismatchSnapshot = server; });

export function ProtocolBanner() {
    const server = useSyncExternalStore(
        (notify) => onProtocolMismatch(() => notify()),
        () => mismatchSnapshot,
        () => null,
    );
    if (server === null) return null;
    return (
        <div className="update-banner error" role="alert" data-testid="protocol-banner">
            서버가 새 버전(protocol {server})으로 바뀌어 이 화면에서는 변경 요청을 보낼 수 없습니다.
            새 UI가 준비되면 지금 업데이트를 선택하세요. 초안은 기기 저장소에 의존하므로 중요한 입력은 먼저 복사하세요.
            <Button onClick={() => void checkForUpdate()}>새 UI 확인</Button>
        </div>
    );
}

export function UpdateBanner() {
    const { online } = useLifecycle();
    const current = useSyncExternalStore(
        (notify) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
        () => snapshot,
        () => snapshot,
    );
    if (!current.worker && !current.error) return null;
    return (
        <div className="update-banner pwa-update-notices">
            {current.error && <GroveText as="p" display="block" type="inherit" color="inherit" className="error" role="alert">{current.error}</GroveText>}
            {current.worker && <div role="status" className="pwa-update">
                <SentenceText text="새 버전이 준비되었습니다. 업데이트하면 저장하지 않은 입력이 사라질 수 있습니다." />
                <div className="pwa-update-actions">
                    <Button type="button" className="ghost small" onClick={() => publish(null, current.error)}>나중에</Button>
                    <Button type="button" className="small" onClick={applyUpdate} disabled={!online} title={!online ? "연결 후 업데이트할 수 있습니다" : undefined}>업데이트</Button>
                </div>
            </div>}
        </div>
    );
}
