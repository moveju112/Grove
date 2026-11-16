import { api } from "../api/client";
import { connection } from "../api/transport";
import { requestNotificationAccess } from "../components/capabilities/browser";

export async function pushServerId(): Promise<string> {
    const source = JSON.stringify(connection() ?? { origin: location.origin });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function pushRegistration() {
    if (!isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("이 환경은 Push를 지원하지 않아. iPhone은 홈 화면에 추가한 앱에서 열어줘.");
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (!registration?.active) throw new Error("앱을 다시 열어 알림 준비를 마친 뒤 켜줘.");
    return registration;
}
export const pushConfiguration = () => api.getContract("PushConfig", "/web-push");
export async function enablePush(vibrate: boolean) {
    // 권한 요청은 사용자의 직접 조작에서 시작한다(iOS 포함).
    const permission = await requestNotificationAccess();
    if (permission.permission !== "granted") throw new Error(permission.message ?? "브라우저 알림 권한을 허용해줘.");
    const registration = await pushRegistration();
    const config = await pushConfiguration();
    const key = Uint8Array.from(atob(config.public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const existing = await registration.pushManager.getSubscription();
    // 다른 서버의 VAPID 구독을 조용히 덮어쓰지 않는다.
    if (existing?.options.applicationServerKey && new Uint8Array(existing.options.applicationServerKey).some((b, i) => b !== key[i]))
        throw new Error("이 앱은 다른 서버의 Push를 사용 중이야. 그 서버에서 먼저 꺼줘.");
    const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const saved = config.subscriptions.find((s) => s.endpoint === subscription.endpoint);
    await api.put("/web-push", { ...subscription.toJSON(), expirationTime: undefined, scope: registration.scope, server: await pushServerId(), vibrate, expected_revision: saved?.revision ?? 0 });
    return subscription;
}
export async function disablePush() {
    const registration = await pushRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    // 서버 저장이 실패하면 구독을 남겨 같은 요청을 다시 확인할 수 있게 한다.
    await api.del(`/web-push?endpoint=${encodeURIComponent(subscription.endpoint)}`);
    // 다른 서버에서도 사용하는 구독일 수 있으므로 브라우저 구독 자체는 보존한다.
}
