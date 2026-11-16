import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playAttentionSound, showAttention } from "./attention";
import { runNotificationTest } from "./notificationTests";

vi.mock("./attention", async (original) => ({
    ...await original<typeof import("./attention")>(),
    playAttentionSound: vi.fn(),
    showAttention: vi.fn(),
}));

const prefs = { notifySound: false, notifyVibrate: false };
const showNotification = vi.fn();
const getNotifications = vi.fn();
const getRegistration = vi.fn();
const vibrate = vi.fn();

describe("알림 경로별 시험", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubGlobal("Notification", { permission: "granted" });
        vi.stubGlobal("navigator", { vibrate, serviceWorker: { getRegistration } });
        getRegistration.mockResolvedValue({ active: {}, showNotification, getNotifications });
        showNotification.mockResolvedValue(undefined);
        getNotifications.mockImplementation(async ({ tag }: { tag: string }) => [{ tag }]);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("소리만 시험하면 꺼진 설정과 무관하게 소리만 요청한다", async () => {
        vi.mocked(playAttentionSound).mockReturnValue("running");
        expect(await runNotificationTest("sound", prefs)).toMatchObject({ status: "requested" });
        expect(playAttentionSound).toHaveBeenCalledOnce();
        expect(vibrate).not.toHaveBeenCalled();
        expect(getRegistration).not.toHaveBeenCalled();
        vi.mocked(playAttentionSound).mockReturnValue("suspended");
        expect(await runNotificationTest("sound", prefs)).toMatchObject({ status: "unavailable", message: expect.stringContaining("suspended") });
        vi.mocked(playAttentionSound).mockReturnValue("unsupported");
        expect(await runNotificationTest("sound", prefs)).toMatchObject({ status: "unavailable" });
    });

    it("단일·패턴 진동은 비동기 작업 전에 각 패턴을 직접 요청한다", async () => {
        vibrate.mockReturnValue(true);
        const single = runNotificationTest("vibrate", prefs);
        expect(vibrate).toHaveBeenLastCalledWith(1000);
        expect(await single).toMatchObject({ status: "requested" });
        const pattern = runNotificationTest("pattern", prefs);
        expect(vibrate).toHaveBeenLastCalledWith([180, 80, 180]);
        expect(await pattern).toMatchObject({ status: "requested" });
        expect(playAttentionSound).not.toHaveBeenCalled();
        expect(showNotification).not.toHaveBeenCalled();
    });

    it("직접 진동 미지원·거절·예외를 성공으로 표시하지 않는다", async () => {
        vibrate.mockReturnValue(false);
        expect(await runNotificationTest("vibrate", prefs)).toMatchObject({ status: "unavailable", message: expect.stringContaining("false") });
        vibrate.mockImplementation(() => { throw new DOMException("blocked", "NotAllowedError"); });
        expect(await runNotificationTest("pattern", prefs)).toMatchObject({ status: "error", message: expect.stringContaining("NotAllowedError") });
        vi.stubGlobal("navigator", {});
        expect(await runNotificationTest("vibrate", prefs)).toMatchObject({ status: "unavailable" });
    });

    it("기본 시스템 시험은 진동 옵션을 생략하고 진동 시험에만 패턴을 넘긴다", async () => {
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "requested", message: expect.stringContaining("목록에 등록됨") });
        expect(showNotification).toHaveBeenLastCalledWith("Grove 알림 시험 · 기본", {
            body: "상단 알림창에서 이 알림이 보이는지 확인해줘.", tag: expect.stringContaining("test:system:"),
        });
        expect(await runNotificationTest("system-vibrate", prefs)).toMatchObject({ status: "requested" });
        expect(showNotification).toHaveBeenLastCalledWith("Grove 알림 시험 · 진동", expect.objectContaining({ vibrate: [180, 80, 180] }));
        expect(vibrate).not.toHaveBeenCalled();
        expect(playAttentionSound).not.toHaveBeenCalled();
        expect(showAttention).not.toHaveBeenCalled();
    });

    it("같은 시각의 반복 시험도 서로 다른 알림으로 등록한다", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1000);
        try {
            await runNotificationTest("system", prefs);
            await runNotificationTest("system", prefs);
            expect(showNotification.mock.calls[0]![1].tag).not.toBe(showNotification.mock.calls[1]![1].tag);
        } finally { vi.mocked(Date.now).mockRestore(); }
    });

    it("권한 없음·서비스 워커 미지원·비활성 상태에서는 알림을 요청하지 않는다", async () => {
        vi.stubGlobal("Notification", { permission: "denied" });
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "unavailable", message: expect.stringContaining("denied") });
        expect(getRegistration).not.toHaveBeenCalled();
        vi.stubGlobal("Notification", { permission: "granted" });
        getRegistration.mockResolvedValue(undefined);
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "unavailable", message: expect.stringContaining("활성 서비스 워커") });
        vi.stubGlobal("navigator", {});
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "unavailable" });
        expect(showNotification).not.toHaveBeenCalled();
    });

    it("실제 요청 실패와 요청 후 등록 조회 실패를 구분한다", async () => {
        showNotification.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "error", message: expect.stringContaining("NotAllowedError") });
        expect(getNotifications).not.toHaveBeenCalled();
        getNotifications.mockResolvedValueOnce([]);
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "unconfirmed", message: expect.stringContaining("목록에는 없어") });
        getNotifications.mockRejectedValueOnce(new Error("unavailable"));
        expect(await runNotificationTest("system", prefs)).toMatchObject({ status: "unconfirmed", message: expect.stringContaining("등록 조회에 실패") });
    });

    it("현재 설정 시험만 기존 전달 경로와 소리·진동 설정을 사용한다", async () => {
        vi.mocked(showAttention).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect(await runNotificationTest("configured", { notifySound: true, notifyVibrate: true })).toMatchObject({ status: "requested" });
        expect(showAttention).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Grove 알림 시험", projectId: null, sessionId: null }), true, true);
        expect(await runNotificationTest("configured", prefs)).toMatchObject({ status: "error" });
        expect(showAttention).toHaveBeenLastCalledWith(expect.anything(), false, false);
        expect(getRegistration).not.toHaveBeenCalled();
    });
});
