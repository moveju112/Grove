import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    attachmentIssue, browserEnvironment, capabilityIssue, copyMessageText, detectBrowserCapabilities, observeBrowserCapabilities,
    requestNotificationAccess, type BrowserEnvironment, type CapabilityId,
} from "./browser";
import { BrowserCapabilitiesPanel } from "./BrowserCapabilities";
import { MessageCopyButton } from "./MessageCopyButton";

function environment(patch: Partial<BrowserEnvironment> = {}): BrowserEnvironment {
    return {
        secureContext: true,
        notification: { permission: "default", requestPermission: vi.fn(async () => "granted" as const) },
        clipboard: { readText: vi.fn(async () => "private"), writeText: vi.fn(async () => undefined) },
        fileSelect: true, fileDrop: true, fileOpen: true, fileSave: true, directory: true,
        ...patch,
    };
}
function row(env: BrowserEnvironment, id: CapabilityId) {
    return detectBrowserCapabilities(env).items.find((item) => item.id === id)!;
}
function status(state: PermissionState) {
    return Object.assign(new EventTarget(), { state }) as PermissionStatus;
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }

afterEach(() => vi.unstubAllGlobals());

describe("브라우저 기능의 수동 탐지", () => {
    it("가짜 navigator와 window에서 기능만 탐지하고 파일 picker를 열지 않는다", () => {
        const env = environment();
        const picker = vi.fn();
        vi.stubGlobal("window", { isSecureContext: true, showOpenFilePicker: picker });
        vi.stubGlobal("navigator", { clipboard: env.clipboard });
        vi.stubGlobal("Notification", env.notification);
        vi.stubGlobal("document", { createElement: () => ({ type: "", files: null }), documentElement: { ondrop: null } });
        vi.stubGlobal("File", class { arrayBuffer() {} });
        vi.stubGlobal("DataTransfer", class { get files() { return []; } });
        expect(browserEnvironment()).toMatchObject({
            secureContext: true, clipboard: env.clipboard, fileSelect: true, fileDrop: true,
            fileOpen: true, fileSave: false, directory: false,
        });
        expect(picker).not.toHaveBeenCalled();
        expect(env.clipboard!.readText).not.toHaveBeenCalled();
        expect(env.notification!.requestPermission).not.toHaveBeenCalled();
    });

    it("API 존재·미결정·보안 요구를 나누고 권한·Clipboard·파일 창은 실행하지 않는다", () => {
        const env = environment();
        const value = detectBrowserCapabilities(env);
        const html = renderToStaticMarkup(createElement(BrowserCapabilitiesPanel, { snapshot: value }));
        expect(value.items).toHaveLength(8);
        expect(row(env, "notifications")).toMatchObject({ supported: true, permission: "prompt", secureRequired: true });
        expect(row(env, "file-select")).toMatchObject({ supported: true, permission: "per-use", secureRequired: false });
        expect(html).toContain("미결정");
        expect(html).toContain("조회 불가·미확인");
        expect(html).toContain("선택한 파일·폴더마다 확인");
        expect(html).toContain("보안 컨텍스트: <strong>예");
        expect(html).not.toContain("HTTPS 또는 localhost");
        expect(env.notification!.requestPermission).not.toHaveBeenCalled();
        expect(env.clipboard!.readText).not.toHaveBeenCalled();
        expect(env.clipboard!.writeText).not.toHaveBeenCalled();
    });

    it("미지원 API와 조회 불가 권한을 거부로 표시하지 않는다", () => {
        const env = environment({ notification: undefined, clipboard: {}, fileSelect: false, fileDrop: false, fileOpen: false, fileSave: false, directory: false });
        const value = detectBrowserCapabilities(env);
        expect(value.items.every((item) => !item.supported)).toBe(true);
        const html = renderToStaticMarkup(createElement(BrowserCapabilitiesPanel, { snapshot: value }));
        expect(html).toContain("미지원");
        expect(html).toContain("해당 없음");
        expect(html).toContain("Ctrl+C");
        expect(html).toContain("Ctrl+V");
        expect(html).toContain("개별 첨부");
        expect(html).toContain("원문 다운로드");
        expect(html).not.toContain("권한이 거부");
    });

    it("일반 HTTP에서 보안 제한을 API 존재·알림 거부와 구분하고 일반 파일 첨부는 유지한다", () => {
        const env = environment({ secureContext: false, notification: { permission: "denied", requestPermission: vi.fn() } });
        const value = detectBrowserCapabilities(env);
        const html = renderToStaticMarkup(createElement(BrowserCapabilitiesPanel, { snapshot: value }));
        expect(row(env, "notifications")).toMatchObject({ supported: true, permission: "denied" });
        expect(capabilityIssue(value, row(env, "notifications"))).toContain("보안 컨텍스트가 아닙니다");
        expect(attachmentIssue(env)).toBeNull();
        expect(html).toContain("보안 컨텍스트 불필요");
        expect(html).toContain("보안 컨텍스트: <strong>아니요");
        expect(html).toContain("HTTPS 또는 localhost");
        const hidden = detectBrowserCapabilities(environment({ secureContext: false, notification: undefined, clipboard: undefined }));
        const hiddenHtml = renderToStaticMarkup(createElement(BrowserCapabilitiesPanel, { snapshot: hidden }));
        expect(hiddenHtml).toContain("미노출·보안 컨텍스트에서 재확인");
        expect(hiddenHtml).not.toContain("이 브라우저는 이 API를 지원하지 않습니다");
    });

    it("Clipboard 읽기·쓰기를 독립 탐지하고 파일 시스템 picker도 각각 구분한다", () => {
        const env = environment({ clipboard: { writeText: vi.fn() }, fileOpen: false, directory: false });
        expect(row(env, "clipboard-read").supported).toBe(false);
        expect(row(env, "clipboard-write").supported).toBe(true);
        expect(row(env, "file-open").supported).toBe(false);
        expect(row(env, "file-save").supported).toBe(true);
        expect(row(env, "directory").supported).toBe(false);
    });

    it("Permissions API 허용·거부·미결정과 변경을 반영하고 구독을 정리한다", async () => {
        const states = { notifications: status("granted"), "clipboard-read": status("denied"), "clipboard-write": status("prompt") };
        const env = environment({ permissions: { query: vi.fn(async (descriptor) => states[descriptor.name as keyof typeof states]) } });
        const publish = vi.fn();
        const dispose = observeBrowserCapabilities(env, publish);
        await flush();
        const latest = () => publish.mock.lastCall![0] as ReturnType<typeof detectBrowserCapabilities>;
        expect(latest().items.find((item) => item.id === "notifications")!.permission).toBe("granted");
        const denied = latest().items.find((item) => item.id === "clipboard-read")!;
        expect(denied.permission).toBe("denied");
        expect(capabilityIssue(latest(), denied)).toContain("사이트");
        const html = renderToStaticMarkup(createElement(BrowserCapabilitiesPanel, { snapshot: latest() }));
        expect(html).toContain("허용");
        expect(html).toContain("거부");
        expect(html).toContain("브라우저 사이트 설정");
        Object.assign(states["clipboard-read"], { state: "granted" });
        states["clipboard-read"].dispatchEvent(new Event("change"));
        expect(latest().items.find((item) => item.id === "clipboard-read")!.permission).toBe("granted");
        dispose();
        const calls = publish.mock.calls.length;
        states["clipboard-read"].dispatchEvent(new Event("change"));
        expect(publish).toHaveBeenCalledTimes(calls);
        expect(env.notification!.requestPermission).not.toHaveBeenCalled();
        expect(env.clipboard!.readText).not.toHaveBeenCalled();
        expect(env.clipboard!.writeText).not.toHaveBeenCalled();
    });

    it("권한 descriptor 조회 실패는 미확인이며 unmount 뒤 늦은 결과는 무시한다", async () => {
        const publish = vi.fn();
        const env = environment({ permissions: { query: vi.fn(async () => { throw new TypeError("unsupported descriptor"); }) } });
        const dispose = observeBrowserCapabilities(env, publish);
        await flush();
        expect(publish.mock.lastCall![0].items.find((item: { id: string }) => item.id === "clipboard-read").permission).toBe("unknown");
        dispose();
        let resolve!: (value: PermissionStatus) => void;
        const query = vi.fn(() => new Promise<PermissionStatus>((done) => { resolve = done; }));
        const late = vi.fn();
        const stop = observeBrowserCapabilities(environment({ clipboard: undefined, permissions: { query } }), late);
        stop();
        resolve(status("granted"));
        await flush();
        expect(late).toHaveBeenCalledTimes(1);
    });
});

describe("의도적인 진입점 동작과 대안", () => {
    it("알림 요청은 명시적 실행 때만 하고 거부·미지원·비보안이면 요청하지 않는다", async () => {
        const env = environment();
        expect(await requestNotificationAccess(env)).toEqual({ permission: "granted", message: undefined });
        expect(env.notification!.requestPermission).toHaveBeenCalledTimes(1);
        for (const patch of [
            { secureContext: false }, { notification: undefined },
            { notification: { permission: "denied" as const, requestPermission: vi.fn() } },
        ]) {
            const blocked = environment(patch);
            expect((await requestNotificationAccess(blocked)).message).toContain("알림 목록");
            if (blocked.notification) expect(blocked.notification.requestPermission).not.toHaveBeenCalled();
        }
    });

    it("알림 요청 거부·닫기·예외에 대안을 반환하고 허용된 권한은 다시 묻지 않는다", async () => {
        for (const permission of ["denied", "default"] as const) {
            const result = await requestNotificationAccess(environment({ notification: { permission: "default", requestPermission: vi.fn(async () => permission) } }));
            expect(result.permission).toBe(permission);
            expect(result.message).toContain("알림 목록");
        }
        const granted = environment({ notification: { permission: "granted", requestPermission: vi.fn() } });
        expect((await requestNotificationAccess(granted)).permission).toBe("granted");
        expect(granted.notification!.requestPermission).not.toHaveBeenCalled();
        const result = await requestNotificationAccess(environment({ notification: { permission: "default", requestPermission: vi.fn(async () => { throw new Error("blocked"); }) } }));
        expect(result.message).toContain("요청하지 못했습니다");
    });

    it("복사는 실제 성공 때만 성공하고 미지원·비보안·거부 실패 때 수동 원문 복사를 안내한다", async () => {
        const env = environment();
        const text = "**원문**\n<not-html>";
        expect(await copyMessageText(text, env)).toEqual({ copied: true });
        expect(env.clipboard!.writeText).toHaveBeenCalledWith(text);
        for (const blocked of [
            environment({ clipboard: undefined }),
            environment({ secureContext: false }),
            environment({ clipboard: { writeText: vi.fn(async () => { throw new DOMException("blocked", "NotAllowedError"); }) } }),
        ]) {
            expect(await copyMessageText(text, blocked)).toMatchObject({ copied: false, message: expect.stringContaining("Ctrl+C") });
        }
        const html = renderToStaticMarkup(createElement(MessageCopyButton, { text }));
        expect(html).toContain("메시지 복사");
        expect(html).not.toContain("복사됨");
        expect(html).not.toContain("textarea");
    });

    it("파일 시스템 접근 API 없이도 일반 첨부를 지원하고 일반 선택 미지원 때 붙여넣기를 안내한다", () => {
        expect(attachmentIssue(environment({ fileOpen: false, fileSave: false, directory: false }))).toBeNull();
        expect(attachmentIssue(environment({ fileSelect: false }))).toContain("메시지에 붙여 넣거나");
    });
});
