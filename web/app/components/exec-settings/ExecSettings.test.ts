import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isExecSetting, type ExecSettingDef } from "../../api/execSettings";
import { ExecSettings } from "./ExecSettings";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../state/store", () => ({ useQuery: query }));
vi.mock("../SettingsReset", () => ({
    SettingsResetButton: () => null,
    APPLIES: { next_turn: "다음 요청부터 적용" },
    SCOPE_LABEL: { default: "기본값", server: "서버 전체", project: "이 프로젝트", session: "이 대화" },
}));
afterEach(() => vi.clearAllMocks());

const shell: ExecSettingDef = {
    key: "exec.shell", menu: "agents", label: "명령 실행 셸", description: "fixture description", keywords: "shell",
    kind: "enum", options: ["default", "sh"], min: null, max: null, default: "default",
    scopes: ["server", "project", "session"], applies: "next_turn", advanced: false,
    unavailable_options: [{ value: "cmd", reason: "이 서버 OS에서 지원하지 않습니다" }],
};

function render(def: ExecSettingDef = shell, target = { projectId: "p", sessionId: "s" }) {
    query.mockReturnValue({
        data: { items: [{
            key: def.key, default: def.default, effective: "sh", source: "project",
            layers: { server: { value: null, revision: 0 }, project: { value: "sh", revision: 2 }, session: { value: null, revision: 0 } },
        }] }, reload: vi.fn(),
    });
    return renderToStaticMarkup(createElement(ExecSettings, { defs: [def], target }));
}

describe("실행 설정의 기존 범위별 편집기 연결", () => {
    it("대화 대상을 고정하고 상속값·적용 시점·기본 cwd의 적용 범위를 표시한다", () => {
        const html = render();
        expect(query).toHaveBeenCalledWith("settings:s", expect.any(Function));
        expect(html).toContain('<option value="session" selected="">');
        expect(html).toContain("명령 실행 셸 도움말");
        expect(html).toContain("이 프로젝트");
        expect(html).toContain("이미 계획·승인된 호출의 shell·limits·cwd는 바꾸지 않습니다");
        expect(html).toContain("sandbox가 아닙니다");
        const cwd = render({ ...shell, key: "exec.default_cwd", kind: "string", options: [] });
        expect(cwd).toContain("cwd를 생략한 새 모델 셸·대화 작업에 적용됩니다");
        expect(cwd).toContain("명시한 cwd(‘.’ 포함)가 우선");
        expect(cwd).toContain("실제 실행 root(worktree 포함)");
        expect(cwd).toContain("프로젝트 script는 확인한 root에서 실행");
        expect(cwd).toContain("터미널·hook·외부 CLI에는 적용하지 않습니다");
    });

    it("지원하는 값만 편집기에 전달하고 미지원 선택지는 이유와 함께 비활성으로 표시한다", () => {
        const html = render();
        expect(html).toContain('<option value="sh" selected="">');
        expect(html).toContain("<legend>명령 실행 셸 미지원 선택지</legend>");
        expect(html.match(/<input[^>]*value="cmd"[^>]*>/)?.[0]).toContain('disabled=""');
        expect(html).toContain("cmd · 이 서버 OS에서 지원하지 않습니다");
        const disabled = render({ ...shell, disabled_reason: "이 서버에서는 자원 한도를 지원하지 않습니다" });
        expect(disabled).toContain('<fieldset disabled=""');
        expect(disabled).toContain("이 서버에서는 자원 한도를 지원하지 않습니다");
    });

    it("실행 설정만 분류하고 다른 설정을 전용 영역으로 옮기지 않는다", () => {
        for (const key of ["exec.shell", "exec.max_memory_mb", "exec.max_cpu_seconds", "exec.isolation", "exec.default_cwd"]) {
            expect(isExecSetting({ ...shell, key })).toBe(true);
        }
        expect(isExecSetting({ ...shell, key: "output.language" })).toBe(false);
        expect(isExecSetting({ ...shell, key: "exec.unknown" })).toBe(false);
    });
});
