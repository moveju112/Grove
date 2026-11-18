import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Text } from "@astryxdesign/core/Text";
import { authGeneration, isLoggedIn } from "../api/client";
import { Button } from "../design/Button";
import { notificationPermission } from "../state/attention";
import { loadPrefs } from "../state/device";
import { syncPush } from "../state/webPush";
import { BooleanSelect } from "./BooleanSelect";

type PushStatus = { busy: boolean; error: string | null; refreshPermission: () => void; retry: () => void };
export const PushStatusContext = createContext<PushStatus | null>(null);

let pending = Promise.resolve();

export function usePushSync(enabled: boolean, vibrate: boolean, blocked: boolean): PushStatus {
    const [permission, setPermission] = useState(notificationPermission);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const syncedVibration = useRef<boolean | undefined>(undefined);
    const handledAttempt = useRef(0);
    const refreshPermission = () => setPermission(notificationPermission());

    useEffect(() => {
        let disposed = false;
        let status: PermissionStatus | undefined;
        window.addEventListener("focus", refreshPermission);
        document.addEventListener("visibilitychange", refreshPermission);
        void navigator.permissions?.query({ name: "notifications" }).then((result) => {
            if (disposed) return;
            status = result;
            status.addEventListener("change", refreshPermission);
            refreshPermission();
        }).catch(() => {});
        return () => {
            disposed = true;
            status?.removeEventListener("change", refreshPermission);
            window.removeEventListener("focus", refreshPermission);
            document.removeEventListener("visibilitychange", refreshPermission);
        };
    }, []);

    useEffect(() => {
        setBusy(false);
        setError(null);
        if (blocked || (enabled && permission !== "granted") || !isSecureContext || !("PushManager" in window) || !navigator.serviceWorker) return;
        const epoch = authGeneration();
        let disposed = false;
        const current = () => {
            if (disposed || !isLoggedIn() || authGeneration() !== epoch) return false;
            const prefs = loadPrefs();
            return prefs.notifyPush === enabled && (!enabled || prefs.notifyVibrate === vibrate);
        };
        void navigator.serviceWorker.ready.then((registration) => {
            if (!current()) return;
            setBusy(true);
            const reconcile = async () => {
                if (!current()) return;
                const updateVibration = handledAttempt.current !== attempt
                    || (syncedVibration.current !== undefined && syncedVibration.current !== vibrate);
                if (await syncPush(registration, enabled, vibrate, updateVibration, current)) {
                    if (current()) setError("최근 푸시 전달에 실패했습니다.");
                }
                if (current()) {
                    syncedVibration.current = enabled ? vibrate : undefined;
                    handledAttempt.current = attempt;
                }
            };
            const run = pending.then(async () => {
                if (navigator.locks) await navigator.locks.request("grove-web-push", reconcile);
                else await reconcile();
            });
            pending = run.catch(() => {});
            return run;
        }).catch((e: unknown) => {
            if (current()) setError(e instanceof Error ? e.message : "푸시 설정을 적용하지 못했습니다.");
        }).finally(() => { if (current()) setBusy(false); });
        return () => { disposed = true; };
    }, [enabled, vibrate, blocked, permission, attempt]);

    return { busy, error, refreshPermission, retry: () => setAttempt((n) => n + 1) };
}

export function PushNotifications({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
    const status = useContext(PushStatusContext);
    return <>
        <BooleanSelect label="앱을 닫아도 완료 알림" value={enabled} onChange={onChange} />
        <Text as="p" type="supporting" color="secondary">지원되는 브라우저에서 알림을 허용하면 완료·실패를 기기 알림으로 받아요.</Text>
        {status?.error && <>
            <Text as="p" type="supporting" color="warning" role="status">{status.error}</Text>
            <Button variant="secondary" density="compact" disabled={status.busy} onClick={status.retry}>푸시 설정 다시 적용</Button>
        </>}
    </>;
}
