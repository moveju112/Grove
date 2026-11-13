import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceSettingsPanel } from "./SourceSettingsPanel";
import type { ReadErrorCode, SafeSettings, SourceSettings, SourceSettingsView } from "./types";

function render(view: SourceSettingsView) {
    return renderToStaticMarkup(createElement(SourceSettingsPanel, { view }));
}

function ready(items: SourceSettings[]) {
    return render({ status: "ready", items });
}

describe("원본 설정의 읽기 전용 출처", () => {
    it("원본과 Grove 실제 적용 설정을 구분하고 쓰기 동작을 제공하지 않는다", () => {
        const html = ready([{
            source: "claude_project", status: "present",
            projection: { alwaysThinkingEnabled: true, autoCompactEnabled: false, cleanupPeriodDays: 0 },
            ignored_invalid_fields: false,
        }]);
        expect(html).toContain("Claude · 프로젝트 원본");
        expect(html).toContain(".claude/settings.json");
        expect(html).toContain("원본을 조회했다고 Grove에 적용된 것은 아닙니다");
        expect(html).toContain("Grove의 범위별 설정 화면");
        expect(html).toContain("켜짐");
        expect(html).toContain("꺼짐");
        expect(html).toContain("0일");
        expect(html).not.toMatch(/<(button|input|textarea|select|form)\b/);
    });

    it("부재·읽기 실패·미지원·안전 필드 없음 상태를 구별한다", () => {
        const html = ready([
            { source: "claude_user", status: "missing" },
            { source: "claude_project", status: "read_error", code: "invalid_json" },
            { source: "claude_project_local", status: "present", projection: {}, ignored_invalid_fields: true },
            { source: "codex_user", status: "unsupported_format", format: "toml" },
            { source: "codex_project", status: "missing" },
        ]);
        expect(html).toContain("원본 파일 또는 출처 디렉터리가 없습니다");
        expect(html).toContain("올바른 JSON이 아니어서");
        expect(html).toContain("표시 가능한 안전 필드가 없습니다");
        expect(html).toContain("타입이나 범위가 맞지 않는 값은 생략");
        expect(html).toContain("미지원 형식(TOML)");
        expect(html).toContain("Claude · 프로젝트 로컬 원본");
        expect(html).toContain("Codex · 프로젝트 원본");
    });

    it("허용하지 않은 키와 문자열 값은 props에 섞여도 출력하지 않는다", () => {
        const projection = {
            env: { SYNTHETIC: "fixture-only-marker" },
            apiKeyHelper: "fixture-only-marker",
            unknown: "<script>fixture-only-marker</script>",
            alwaysThinkingEnabled: "fixture-only-marker",
            cleanupPeriodDays: "fixture-only-marker",
        } as unknown as SafeSettings;
        const html = ready([{ source: "claude_user", status: "present", projection, ignored_invalid_fields: true }]);
        expect(html).not.toContain("fixture-only-marker");
        expect(html).not.toContain("apiKeyHelper");
        expect(html).not.toContain("SYNTHETIC");
        expect(html).toContain("표시 가능한 안전 필드가 없습니다");
    });

    it("모든 읽기 오류 코드를 원문 없는 오류 안내로 표시한다", () => {
        const cases: [ReadErrorCode, string][] = [
            ["permission_denied", "원본을 읽을 권한이 없거나"],
            ["not_regular_file", "일반 파일이 아니라"],
            ["too_large", "256 KiB"],
            ["invalid_json", "올바른 JSON이 아니어서"],
            ["invalid_shape", "JSON 객체 형식이 아니어서"],
            ["io", "원본을 읽지 못했습니다"],
        ];
        for (const [code, message] of cases) {
            const html = ready([{ source: "claude_user", status: "read_error", code }]);
            expect(html).toContain('role="alert"');
            expect(html).toContain(message);
        }
    });

    it("로딩·목록 오류·조회 대상 없음은 파일 부재로 오인시키지 않는다", () => {
        expect(render({ status: "loading" })).toContain('role="status"');
        expect(render({ status: "error" })).toContain("원본 출처 목록을 가져오지 못했습니다");
        const html = ready([]);
        expect(html).toContain("원본 파일이 없다는 뜻은 아닙니다");
        expect(html).not.toContain("원본 파일 또는 출처 디렉터리가 없습니다");
    });
});
