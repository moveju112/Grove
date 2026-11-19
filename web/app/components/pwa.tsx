import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
// 입력이 없는 탭은 새 버전을 바로 적용하고, 입력이 남은 탭은 사용자가 고를 때까지 기다린다.
import { useSyncExternalStore } from "react";
import { onProtocolMismatch } from "../api/client";
import { deployment } from "../deployment";
import { Button } from "../design/Button";
import { SentenceText } from "./HelpTip";
import { useLifecycle } from "./pwa/lifecycle";
import { hasPendingInput, trackPendingInput } from "./pwa/pendingInput";
import { Banner } from "@astryxdesign/core/Banner";
import { noticeStyles } from "../design/notices.stylex";

let waiting: ServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let updateRequested = false;
let reloaded = false;
type WebUpdateResult = "available" | "up_to_date" | "unavailable" | "failed";
let manualCheck: Promise<WebUpdateResult> | null = null;
let snapshot: { worker: ServiceWorker | null; error: string | null } = { worker: null, error: null };
const subscribers = new Set<() => void>();
function publish(worker: ServiceWorker | null, error: string | null = null) {
    snapshot = { worker, error };
    subscribers.forEach((notify) => notify());
}
function checkWaiting(worker: ServiceWorker | null) {
    if (worker && navigator.serviceWorker.controller && worker !== waiting) {
        waiting = worker;
        if (!manualCheck && navigator.onLine && !hasPendingInput()) applyUpdate();
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
        const observeInstalling = () => {
            const worker = reg.installing;
            const inspect = () => {
                if (worker?.state === "installed") checkWaiting(worker);
                if (worker?.state === "redundant" && !manualCheck) publish(snapshot.worker, "새 UI cache 설치에 실패했습니다. 현재 탭은 유지합니다. 입력을 복사하고 저장 공간·연결을 확인하세요.");
                checkWaiting(reg.waiting);
            };
            worker?.addEventListener("statechange", inspect);
            // 등록·updatefound 콜백이 실행될 때 설치가 이미 진행됐거나 끝났을 수 있다.
            inspect();
        };
        reg.addEventListener("updatefound", observeInstalling);
        observeInstalling();
        // 시작 HTML은 cache에서 즉시 표시할 수 있다. 새 버전 확인은 화면 표시·인증과 별도로 진행한다.
        if (navigator.serviceWorker.controller && navigator.onLine && !reg.installing && !reg.waiting && !updateRequested) void checkForUpdate();
        setInterval(() => {
            if (navigator.onLine) void checkForUpdate();
        }, 30 * 60 * 1000);
    }).catch(() => {
        publish(null, "앱 cache를 등록하지 못했습니다. 오프라인 재실행을 보장할 수 없습니다. 연결과 브라우저 저장 설정을 확인하세요.");
    });
}

export async function checkForUpdate() {
    if (!registration || manualCheck) return;
    try {
        await registration.update();
        checkWaiting(registration.waiting);
        if (registration.waiting && !updateRequested) publish(registration.waiting);
    } catch {
        publish(snapshot.worker, "새 UI 확인에 실패했습니다. 현재 탭은 유지합니다. 연결과 브라우저 저장 공간을 확인하세요.");
    }
}

/** 상태 점의 수동 확인은 새 버전을 준비하되, 입력이 없어도 현재 탭을 전환하지 않는다. */
export function checkWebUpdate(): Promise<WebUpdateResult> {
    if (manualCheck) return manualCheck;
    const reg = registration;
    if (!reg) return Promise.resolve("unavailable");
    manualCheck = Promise.resolve().then(async (): Promise<WebUpdateResult> => {
        if (!navigator.onLine) return "failed";
        try {
            await reg.update();
            const installing = reg.installing;
            if (installing) {
                await new Promise<void>((resolve) => {
                    const inspect = () => {
                        if (installing.state === "installing" || installing.state === "parsed") return;
                        installing.removeEventListener("statechange", inspect);
                        resolve();
                    };
                    installing.addEventListener("statechange", inspect);
                    inspect();
                });
                if (installing.state === "redundant") return "failed";
            }
            checkWaiting(reg.waiting);
            if (!waiting) return "up_to_date";
            publish(waiting);
            return "available";
        } catch {
            return "failed";
        }
    }).finally(() => { manualCheck = null; });
    return manualCheck;
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
        <Banner status="error" role="alert" data-testid="protocol-banner" xstyle={noticeStyles.update}
            title={<>서버가 새 버전(protocol {server})으로 바뀌어 이 화면에서는 변경 요청을 보낼 수 없습니다.
                새 UI가 준비되면 지금 업데이트를 선택하세요. 작성 중인 입력은 저장되지 않으므로 중요한 내용은 먼저 복사하세요.</>}
            endContent={<Button onClick={() => void checkForUpdate()}>새 UI 확인</Button>} />
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
        <GroveStack gap={2} xstyle={noticeStyles.update}>
            {current.error && <Banner status="error" role="alert" title={current.error} />}
            {current.worker && <Banner status="info" role="status"
                title={<SentenceText text="새 버전이 준비되었습니다. 업데이트하면 저장하지 않은 입력이 사라질 수 있습니다." />}
                endContent={<GroveStack gap={2} direction="horizontal" align="center" wrap="wrap">
                    <Button type="button" variant="secondary" density="compact" onClick={() => publish(null, current.error)}>나중에</Button>
                    <Button type="button" density="compact" onClick={applyUpdate} disabled={!online} title={!online ? "연결 후 업데이트할 수 있습니다" : undefined}>업데이트</Button>
                </GroveStack>} />}
        </GroveStack>
    );
}
