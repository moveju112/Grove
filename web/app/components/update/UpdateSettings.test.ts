import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServerUpdateStatus } from "../../api/updateSettings";
import { ApiError } from "../../api/client";
import { UpdateSettingsPanel } from "./UpdateSettings";
import { updateResultUnknown } from "./updateState";

const data: ServerUpdateStatus = {
    server: { version: "0.25.0", protocol: 1, schema: 42 },
    settings: { channel: "stable", auto_apply: "notify_only", revision: 0 },
    last_check: null, can_manage: true, readiness: { idle: true, busy: {} }, automatic_application: "not_enabled",
};
const render = (value = data, blocked = false) => renderToStaticMarkup(createElement(UpdateSettingsPanel, {
    data: value, blocked, onSave: () => {},
}));
describe("서버 업데이트 설정 표시", () => {
    it("자동 업데이트 ON/OFF 하나만 표시하고 세부 설정과 수동 확인을 제거한다", () => {
        const html = render();
        for (const text of ["자동 업데이트", "OFF"]) expect(html).toContain(text);
        expect(html).toContain('data-selected-value="false"');
        for (const text of ["업데이트 채널", "자동 적용 범위", "서버 업데이트 확인", "현재 서버 버전", "서버 protocol", "DB schema"]) {
            expect(html).not.toContain(text);
        }
    });
    it.each(["patch", "minor"] as const)("기존 %s 자동 적용 설정은 ON으로 표시한다", (scope) => {
        const html = render({ ...data, settings: { ...data.settings, auto_apply: scope } });
        expect(html).toContain('data-selected-value="true"');
        expect(html).toContain("ON");
    });
    it("일반 기기와 전송 중에는 변경을 막는다", () => {
        const html = render({ ...data, can_manage: false });
        expect(html).toContain("읽기 전용");
        expect(html).toContain('aria-disabled="true"');
        expect(render(data, true)).toContain('aria-disabled="true"');
        expect(render()).not.toContain('aria-disabled="true"');
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
