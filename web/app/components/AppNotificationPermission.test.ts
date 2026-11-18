import { describe, expect, it } from "vitest";
import { APP_NOTIFICATION_STEPS, mobileNotificationPlatform } from "./AppNotificationPermission";

describe("휴대폰의 앱 알림 권한 안내", () => {
    it("Android와 iPhone·iPad에만 해당 플랫폼의 안내를 제공한다", () => {
        expect(mobileNotificationPlatform("Mozilla/5.0 (Linux; Android 14) SamsungBrowser/28.0", 5)).toBe("android");
        expect(mobileNotificationPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", 5)).toBe("ios");
        expect(mobileNotificationPlatform("Mozilla/5.0 (iPad; CPU OS 18_0)", 5)).toBe("ios");
        expect(mobileNotificationPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", 5)).toBe("ios");
        expect(mobileNotificationPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", 0)).toBeNull();
        expect(mobileNotificationPlatform("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0", 0)).toBeNull();
    });
    it("Android는 브라우저가 아닌 설치 앱의 권한을 먼저 안내한다", () => {
        expect(APP_NOTIFICATION_STEPS.android).toEqual([
            "휴대폰 설정에서 애플리케이션을 열어.",
            "Grove를 선택하고 알림의 ‘알림 허용’을 켜.",
            "소리·진동·팝업도 같은 알림 화면에서 확인해.",
        ]);
        expect(APP_NOTIFICATION_STEPS.ios[0]).toBe("iPhone·iPad 설정에서 알림을 열어.");
        expect(APP_NOTIFICATION_STEPS.ios[1]).toContain("홈 화면에 추가한 Grove");
    });
});
