import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPrefs, loadPrefs } from "./device";

function saved(value: unknown) {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(value) });
}
afterEach(() => vi.unstubAllGlobals());

describe("터미널 여러 줄 붙여넣기 확인의 기기 설정", () => {
    it("기존 기기와 잘못된 저장값은 확인을 켜고 명시적인 끄기만 보존한다", () => {
        saved({ theme: "dark" });
        expect(loadPrefs()).toMatchObject({ confirmTerminalPaste: true, theme: "dark" });
        saved({ confirmTerminalPaste: false });
        expect(loadPrefs().confirmTerminalPaste).toBe(false);
        for (const confirmTerminalPaste of [null, 0, 1, "false", {}, []]) {
            saved({ confirmTerminalPaste });
            expect(loadPrefs().confirmTerminalPaste).toBe(true);
        }
        expect(defaultPrefs.confirmTerminalPaste).toBe(true);
    });
});

describe("탐색 영역 사용량 표시의 기기 설정", () => {
    it("기존 기기와 잘못된 저장값은 표시하고 명시적인 숨김만 보존한다", () => {
        saved({ theme: "dark" });
        expect(loadPrefs()).toMatchObject({ showSidebarUsage: true, theme: "dark" });
        saved({ showSidebarUsage: false });
        expect(loadPrefs().showSidebarUsage).toBe(false);
        for (const showSidebarUsage of [null, 0, "false", {}]) {
            saved({ showSidebarUsage });
            expect(loadPrefs().showSidebarUsage).toBe(true);
        }
    });
});

describe("최근 시간 범위의 기기 설정", () => {
    it("기존 전체 선택은 기본 시간 범위로 읽고 다른 설정은 보존한다", () => {
        saved({ recentWindow: "all", recentWindows: ["30m", "12h"], theme: "dark" });
        expect(loadPrefs()).toMatchObject({ recentWindow: "4h", recentWindows: ["30m", "12h"], theme: "dark" });
    });
    it("시간 범위 선택은 유지한다", () => {
        saved({ recentWindow: "12h" });
        expect(loadPrefs().recentWindow).toBe("12h");
    });
});

describe("키보드 단축키의 기기 설정", () => {
    it("기존 저장값은 기본 프리셋을 사용하고 사용자 지정과 해제를 보존한다", () => {
        saved({ theme: "dark" });
        expect(loadPrefs().keyboardShortcuts).toEqual({ preset: "default", bindings: {} });
        saved({ keyboardShortcuts: { preset: "custom", bindings: { newSession: "Alt+KeyK", closeTab: null } } });
        expect(loadPrefs().keyboardShortcuts).toEqual({ preset: "custom", bindings: { newSession: "Alt+KeyK", closeTab: null } });
        saved({ keyboardShortcuts: { preset: "off", bindings: {} } });
        expect(loadPrefs().keyboardShortcuts.preset).toBe("off");
    });
});

describe("실행 중 보내기 방식의 기기 설정", () => {
    it("저장된 방식이 없으면 합치기를 기본으로 쓰고 다른 설정을 보존한다", () => {
        vi.stubGlobal("localStorage", { getItem: () => null });
        expect(loadPrefs().runningSendMode).toBe("steer");
        saved({ theme: "dark", fontSize: 15 });
        expect(loadPrefs()).toMatchObject({ theme: "dark", fontSize: 15, runningSendMode: "steer" });
    });
    it("지원하는 선택을 유지하며 잘못된 값은 합치기로 읽는다", () => {
        for (const runningSendMode of ["queue", "steer", "interrupt"]) {
            saved({ runningSendMode });
            expect(loadPrefs().runningSendMode).toBe(runningSendMode);
        }
        for (const runningSendMode of [null, 7, "", "cancel", {}, []]) {
            saved({ runningSendMode });
            expect(loadPrefs().runningSendMode).toBe("steer");
        }
    });
});

describe("알림의 기기 설정", () => {
    it("저장된 선택이 없는 알림은 모두 켜고 저장된 끄기는 보존한다", () => {
        vi.stubGlobal("localStorage", { getItem: () => null });
        const enabled = { notifyDone: true, notifyApproval: true, notifyServer: true, notifySound: true, notifyVibrate: true, notifyPush: true };
        expect(loadPrefs()).toMatchObject(enabled);
        for (const key of Object.keys(enabled)) {
            saved({ theme: "dark", [key]: false });
            expect(loadPrefs()).toMatchObject({ ...enabled, theme: "dark", [key]: false });
        }
    });
});

describe("진행 중 표시의 기기 설정", () => {
    it("기존 기기에서는 기본 길이·속도로 켜고 다른 설정을 보존한다", () => {
        saved({ theme: "dark", fontSize: 15 });
        expect(loadPrefs()).toMatchObject({
            theme: "dark", fontSize: 15, activityDisplay: "animated", sessionVineLength: "medium", sessionVineSpeed: "normal", sessionVineGroups: 2,
        });
    });
    it("세 표시 모드를 보존하고 이전 켜기·끄기 설정을 읽는다", () => {
        for (const activityDisplay of ["animatedAll", "animated", "static", "hidden"]) {
            saved({ activityDisplay, sessionVines: false });
            expect(loadPrefs().activityDisplay).toBe(activityDisplay);
        }
        saved({ sessionVines: true });
        expect(loadPrefs().activityDisplay).toBe("animated");
        saved({ sessionVines: false });
        expect(loadPrefs().activityDisplay).toBe("hidden");
    });
    it("숨김 상태에서도 길이·속도 선택을 유지한다", () => {
        for (const sessionVineLength of ["short", "medium", "long"]) {
            for (const sessionVineSpeed of ["slow", "normal", "fast"]) {
                saved({ activityDisplay: "hidden", sessionVineLength, sessionVineSpeed });
                expect(loadPrefs()).toMatchObject({ activityDisplay: "hidden", sessionVineLength, sessionVineSpeed });
            }
        }
    });
    it("잘못된 저장값은 기본값으로 읽는다", () => {
        for (const value of [null, 7, "", {}, []]) {
            saved({ activityDisplay: value, sessionVines: value, sessionVineLength: value, sessionVineSpeed: value });
            expect(loadPrefs()).toMatchObject({ activityDisplay: "animated", sessionVineLength: "medium", sessionVineSpeed: "normal" });
        }
    });
    it("잎 무리는 2~7개를 유지하고 범위 밖 값은 기존 기본값 2개로 읽는다", () => {
        for (const sessionVineGroups of [2, 3, 4, 5, 6, 7]) {
            saved({ sessionVineGroups });
            expect(loadPrefs().sessionVineGroups).toBe(sessionVineGroups);
        }
        for (const sessionVineGroups of [null, 0, 1, 8, 2.5, "3", {}, []]) {
            saved({ sessionVineGroups });
            expect(loadPrefs().sessionVineGroups).toBe(2);
        }
    });
});
