import { api, hasCapability } from "../api/client";

const CAPABILITY = "device_activity_v1";
// 서버는 15분 안의 입력을 사용 중으로 본다. 그보다 충분히 자주 보내되 입력마다 요청하지 않는다.
export const REPORT_INTERVAL = 60_000;
const EVENTS = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

/// 이 화면에서 실제 키보드·마우스·터치 입력이 있으면 서버에 알린다. 다른 기기의 Push 생략은 서버가 판단한다.
/// 창을 열어 두기만 하거나 다른 앱에서 입력하는 것은 사용으로 보지 않는다.
export function watchDeviceActivity(now: () => number = Date.now): () => void {
    let last = -Infinity;
    let sending = false;
    const report = (event: Event) => {
        if (sending || document.visibilityState !== "visible") return;
        // 터치 화면의 손가락 이동은 스크롤이다. 마우스 이동만 읽는 중인 사용으로 본다.
        if (event.type === "pointermove" && (event as PointerEvent).pointerType !== "mouse") return;
        if (hasCapability(CAPABILITY) !== true) return;
        const at = now();
        if (at - last < REPORT_INTERVAL) return;
        last = at;
        sending = true;
        void api.post<void>("/presence", {}, { requires: [CAPABILITY], timeoutMs: 10_000 })
            .catch(() => undefined)
            .finally(() => { sending = false; });
    };
    for (const name of EVENTS) window.addEventListener(name, report, { capture: true, passive: true });
    return () => { for (const name of EVENTS) window.removeEventListener(name, report, { capture: true }); };
}
