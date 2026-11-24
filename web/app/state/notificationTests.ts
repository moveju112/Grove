import { notificationPermission, playAttentionSound } from "./attention";

export const NOTIFICATION_TESTS = [
    { id: "sound", label: "1. 소리만 시험" },
    { id: "vibrate", label: "2. 진동 1초 시험" },
    { id: "pattern", label: "3. 진동 패턴 시험" },
    { id: "system", label: "4. 시스템 기본 알림 시험" },
] as const;

export type NotificationTestId = typeof NOTIFICATION_TESTS[number]["id"];
export type NotificationTestResult = {
    status: "requested" | "unavailable" | "unconfirmed" | "error";
    message: string;
};
let sequence = 0;

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
}

// 시험마다 경로를 분리한다. 시스템 기본 시험은 진동 옵션·서버 식별자 계산 없이 최소 요청만 보낸다.
export async function runNotificationTest(id: NotificationTestId): Promise<NotificationTestResult> {
    try {
        if (id === "sound") {
            const state = playAttentionSound();
            if (state === "unsupported") return { status: "unavailable", message: "이 브라우저는 앱 소리 재생을 지원하지 않아." };
            if (state !== "running") return { status: "unavailable", message: `브라우저가 소리 재생을 보류했어 (AudioContext: ${state}).` };
            return { status: "requested", message: "소리 재생 요청됨. 삐 소리가 들리는지 확인해줘." };
        }
        if (id === "vibrate" || id === "pattern") {
            if (typeof navigator.vibrate !== "function") return { status: "unavailable", message: "이 브라우저는 직접 진동을 지원하지 않아." };
            // 사용자 클릭의 활성 상태를 유지하도록 await 전에 호출한다.
            const accepted = navigator.vibrate(id === "vibrate" ? 1000 : [180, 80, 180]);
            return accepted
                ? { status: "requested", message: "직접 진동 요청됨 (반환값: true). 실제로 울렸는지 확인해줘." }
                : { status: "unavailable", message: "브라우저가 직접 진동 요청을 거절했어 (반환값: false)." };
        }
        const tag = `test:${id}:${Date.now()}:${++sequence}`;
        const permission = notificationPermission();
        if (permission !== "granted") return { status: "unavailable", message: `시스템 알림을 요청하지 않았어 (권한: ${permission}).` };
        if (!("serviceWorker" in navigator)) return { status: "unavailable", message: "이 브라우저는 서비스 워커 알림을 지원하지 않아." };
        const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
        if (!registration?.active) return { status: "unavailable", message: "활성 서비스 워커가 없어. 앱을 다시 열고 시험해줘." };
        await registration.showNotification("Grove 알림 시험 · 기본", { body: "상단 알림창에서 이 알림이 보이는지 확인해줘.", tag });
        // 등록 확인도 물리적인 표시·소리·진동을 보장하지는 않는다.
        try {
            const notifications = await registration.getNotifications({ tag });
            return notifications.some((notification) => notification.tag === tag)
                ? { status: "requested", message: "브라우저 알림 목록에 등록됨. 상단 알림창·소리·진동은 직접 확인해줘." }
                : { status: "unconfirmed", message: "요청은 수락됐지만 브라우저 알림 목록에는 없어. 폰에서 직접 확인해줘." };
        } catch (error) {
            return { status: "unconfirmed", message: `알림 요청은 수락됐지만 등록 조회에 실패했어 (${errorName(error)}).` };
        }
    } catch (error) {
        return { status: "error", message: `시험 요청에 실패했어 (${errorName(error)}).` };
    }
}
