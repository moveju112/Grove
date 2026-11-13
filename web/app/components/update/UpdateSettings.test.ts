import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServerUpdateStatus, UpdateCheck } from "../../api/updateSettings";
import { ApiError } from "../../api/client";
import { CheckResult, UpdateSettingsPanel, updateResultUnknown } from "./UpdateSettings";

vi.mock("../When", () => ({ When: ({ at }: { at: string }) => createElement("time", null, at) }));
const data: ServerUpdateStatus = {
    server: { version: "0.25.0", protocol: 1, schema: 42 },
    settings: { channel: "stable", auto_apply: "notify_only", revision: 0 },
    last_check: null, can_manage: true, readiness: { idle: true, busy: {} }, automatic_application: "not_enabled",
};
const render = (value = data, blocked = false) => renderToStaticMarkup(createElement(UpdateSettingsPanel, {
    data: value, blocked, onSave: () => {}, onCheck: () => {},
}));
const check: UpdateCheck = {
    status: "available", channel: "beta", checked_at: "2026-09-21T00:00:00Z", settings_revision: 1,
    release: { current: "0.25.0", available: "0.26.0-beta.1", kind: "upgrade", channel: "beta", platform: "linux-x64", artifact: true, protocol: 1, schema: 42 },
};
describe("서버 업데이트 설정 표시", () => {
    it("현재 버전·protocol·schema와 알림 기본값, PWA 분리·미실행 계약을 표시한다", () => {
        const html = render();
        for (const text of ["0.25.0", "서버 protocol", "42", "알림만 (기본값)", "PWA 화면(UI)", "실행하거나 예약하지 않습니다", "아직 서버 업데이트를 확인하지 않았습니다"]) {
            expect(html).toContain(text);
        }
        expect(html).toContain('<option value="notify_only" selected=""');
        expect(html).toContain('<option value="stable" selected=""');
    });
    it("일반 기기와 전송 중에는 변경·확인을 막는다", () => {
        const html = render({ ...data, can_manage: false });
        expect(html).toContain("읽기 전용");
        expect(html).toContain("<fieldset disabled");
        expect(render(data, true)).toContain("<fieldset disabled");
        expect(render()).not.toContain("<fieldset disabled");
    });
    it("기존 readiness의 작업별 보류 수를 표시한다", () => {
        const html = render({ ...data, readiness: { idle: false, busy: { active_turns: 2, running_tasks: 1, running_terminals: 0 } } });
        expect(html).toContain("적용 보류");
        expect(html).toContain("실행·대기 턴");
        expect(html).not.toContain("실행 중 터미널");
    });
    it("새 버전·최신·실패와 확인 채널·시각을 구분한다", () => {
        const result = (value: UpdateCheck) => renderToStaticMarkup(createElement(CheckResult, { check: value }));
        expect(result(check)).toContain("새 서버 버전 0.26.0-beta.1");
        expect(result(check)).toContain("beta");
        expect(result(check)).toContain(check.checked_at);
        expect(result({ ...check, status: "up_to_date", release: { ...check.release!, kind: "same", available: check.release!.current } })).toContain("최신 버전");
        expect(result({ ...check, status: "up_to_date", release: { ...check.release!, kind: "downgrade", available: "0.24.0" } })).toContain("더 새로운 서버 버전이 없습니다");
        expect(result({ ...check, status: "failed", release: undefined, error: "manifest_check_failed" })).toContain("서명·채널·내용");
        expect(result({ ...check, status: "failed", release: undefined, error: "local_source_unavailable" })).toContain("로컬 업데이트 소스");
        expect(result({ ...check, release: { ...check.release!, artifact: false } })).toContain("현재 플랫폼의 패키지가 없습니다");
    });
    it("manifest에서 온 텍스트도 HTML을 escape한다", () => {
        const html = render({ ...data, last_check: { ...check, release: { ...check.release!, available: "<script>bad</script>" } } });
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
    });
    it("이전 설정의 확인 결과를 현재 채널의 결과로 표시하지 않는다", () => {
        expect(render({ ...data, last_check: check })).toContain("이전 설정에서 확인한 결과");
    });
    it("응답 유실·timeout·서버 오류는 같은 키로 확인하고 권한·revision 거부는 새로 편집할 수 있다", () => {
        for (const error of [
            new TypeError("network"), new ApiError(0, "network_error", "lost"),
            new ApiError(0, "request_timeout", "timeout"), new ApiError(503, "busy", "busy"),
            new ApiError(409, "result_unknown", "unknown"),
            new ApiError(409, "other", "unknown", true, { result_unknown: true }),
        ]) expect(updateResultUnknown(error)).toBe(true);
        for (const error of [
            new ApiError(403, "forbidden", "owner only"),
            new ApiError(409, "revision_conflict", "conflict"),
        ]) expect(updateResultUnknown(error)).toBe(false);
    });
});
