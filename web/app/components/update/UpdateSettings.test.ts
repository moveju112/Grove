import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { UpdateSettingsPanel } from "./UpdateSettings";
import { updateResultUnknown } from "./updateState";

describe("서버 업데이트 설정 표시", () => {
    it.each([
        ["enabled", "항상 켜짐"], ["external", "지원하지 않아요"], ["not_enabled", "수동 업데이트"],
    ] as const)("%s 설치 상태를 표시하고 끌 수 없다", (application, label) => {
        const html = renderToStaticMarkup(createElement(UpdateSettingsPanel, { application }));
        expect(html).toContain(label);
        expect(html).not.toMatch(/OFF|combobox|button/);
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
