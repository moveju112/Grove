import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lifecycle from "./lifecycle";
import { AuthRecovery } from "./AuthRecovery";
import { ServerActionButton } from "./ServerActionButton";
import { ExternalEditorControls } from "../files/ExternalEditor";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("복구 안내와 서버 작업 버튼", () => {
    it.each(["오프라인", "protocol 불일치", "호환 확인 중"])("%s 이유를 버튼과 접근성 설명에 전달한다", (reason) => {
        vi.spyOn(lifecycle, "useServerBlockReason").mockReturnValue(reason);
        const html = renderToStaticMarkup(createElement(ServerActionButton, { title: "원래 설명", children: "실행" }));
        expect(html).toContain('disabled=""');
        expect(html).toContain(`title="${reason}"`);
        expect(html).toContain(`aria-description="${reason}"`);
        expect(html.replace(/<[^>]+>/g, "")).toBe("실행");
    });
    it("복구 후에도 기능 자체의 disabled·설명은 유지한다", () => {
        vi.spyOn(lifecycle, "useServerBlockReason").mockReturnValue(null);
        const html = renderToStaticMarkup(createElement(ServerActionButton, { disabled: true, title: "권한 없음", children: "실행" }));
        expect(html).toContain('disabled=""');
        expect(html).toContain('title="권한 없음"');
        expect(renderToStaticMarkup(createElement(ServerActionButton, { children: "실행" }))).not.toContain("disabled");
    });
    it("cold-start 안내는 인증 전 저장소를 읽거나 초안 입력을 노출하지 않는다", () => {
        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("private draft read"); } });
        vi.spyOn(lifecycle, "useLifecycle").mockReturnValue({ ...lifecycle.lifecycleSnapshot(), online: false });
        const recover = vi.fn();
        const html = renderToStaticMarkup(createElement(AuthRecovery, { recover }));
        for (const text of ["기존 초안을 삭제하지 않았습니다", "원래 계정", "목록과 내용을 표시하지 않습니다", "자동으로 다시 보내지 않습니다"]) {
            expect(html).toContain(text);
        }
        expect(html).not.toContain("<textarea");
        expect(html).not.toContain('type="password"');
        expect(html).toContain('disabled=""');
        expect(recover).not.toHaveBeenCalled();
    });
    it("외부 편집기의 순수 UI에는 호출부가 차단 이유를 전달한다", () => {
        const html = renderToStaticMarkup(createElement(ExternalEditorControls, {
            listing: { available: true, reason: null, editors: [{ id: "fixture", name: "Fixture" }] },
            selected: "fixture", busy: false, disabled: false, blockedReason: "오프라인",
            onOpen: () => {}, onSelect: () => {},
        }));
        expect(html).toContain('disabled=""');
        expect(html).toContain('title="오프라인"');
    });
});
