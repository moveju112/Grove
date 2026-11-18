import { api } from "../api/client";
import { connection } from "../api/transport";

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
export async function syncPush(registration: ServiceWorkerRegistration, enabled: boolean, vibrate: boolean,
    updateVibration: boolean, current: () => boolean): Promise<boolean> {
    if (!current() || (enabled && Notification.permission !== "granted")) return false;
    const existing = await registration.pushManager.getSubscription();
    if (!current() || (!enabled && !existing)) return false;
    const config = await pushConfiguration();
    if (!current()) return false;
    const saved = config.subscriptions.find((s) => s.endpoint === existing?.endpoint);
    if (!enabled) {
        // 다른 서버에서도 사용하는 구독일 수 있으므로 브라우저 구독 자체는 보존한다.
        if (saved) await api.del(`/web-push?endpoint=${encodeURIComponent(saved.endpoint)}`);
        return false;
    }
    const key = Uint8Array.from(atob(config.public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    // 다른 서버의 VAPID 구독을 조용히 덮어쓰지 않는다.
    const existingKey = existing?.options.applicationServerKey && new Uint8Array(existing.options.applicationServerKey);
    if (existingKey && (existingKey.length !== key.length || existingKey.some((b, i) => b !== key[i])))
        throw new Error("이 앱은 다른 서버의 푸시를 사용 중입니다.");
    if (saved && !updateVibration) return !!saved.last_error;
    if (Notification.permission !== "granted") return false;
    const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const server = await pushServerId();
    if (current() && Notification.permission === "granted") {
        await api.put("/web-push", { ...subscription.toJSON(), expirationTime: undefined, scope: registration.scope, server, vibrate, expected_revision: saved?.revision ?? 0 });
    }
    return false;
}
