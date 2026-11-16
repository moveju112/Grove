import { useEffect, useRef, useState } from "react";
import { Text } from "@astryxdesign/core/Text";
import { BooleanSelect } from "./BooleanSelect";
import { disablePush, enablePush, pushConfiguration, pushRegistration } from "../state/webPush";
import { requireServerAction } from "./pwa/lifecycle";

export function PushNotifications({ vibrate }: { vibrate: boolean }) {
    const [enabled, setEnabled] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deliveryError, setDeliveryError] = useState(false);
    useEffect(() => {
        let active = true;
        void (async () => {
            const registration = await pushRegistration();
            const subscription = await registration.pushManager.getSubscription();
            if (!subscription) return;
            const config = await pushConfiguration();
            const current = config.subscriptions.find((s) => s.endpoint === subscription.endpoint);
            if (active) { setEnabled(!!current); setDeliveryError(!!current?.last_error); }
        })().catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Push 상태를 확인하지 못했어."); });
        return () => { active = false; };
    }, []);
    const change = async (on: boolean) => {
        if (busy) return;
        setBusy(true); setError(null);
        try {
            requireServerAction();
            if (on) await enablePush(vibrate); else await disablePush();
            setEnabled(on); setDeliveryError(false);
        } catch (e) { setError(e instanceof Error ? e.message : "Push 설정을 저장하지 못했어."); }
        finally { setBusy(false); }
    };
    const previousVibrate = useRef(vibrate);
    useEffect(() => {
        if (previousVibrate.current !== vibrate) {
            previousVibrate.current = vibrate;
            if (enabled) void change(true);
        }
    }, [vibrate]);
    return <>
        <BooleanSelect label="앱을 닫아도 완료 알림" value={enabled} disabled={busy} onChange={(on) => void change(on)} />
        <Text as="p" type="supporting" color="secondary">완료·실패를 기기 알림으로 받아. 소리·진동은 휴대폰 알림 설정을 따라.</Text>
        {(error || deliveryError) && <Text as="p" type="supporting" color="warning" role="status">{error ?? "최근 Push 전달에 실패했어. 기기 알림 권한을 확인하고 껐다 켜줘."}</Text>}
    </>;
}
