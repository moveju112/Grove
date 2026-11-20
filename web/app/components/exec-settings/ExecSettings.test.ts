import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isExecSetting } from "../../api/execSettings";
import type { SettingDef } from "../ScopedSettings";
import { ExecSettings } from "./ExecSettings";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../state/store", async (original) => ({
    ...await original<typeof import("../../state/store")>(), useQuery: query,
}));
afterEach(() => vi.clearAllMocks());

const shell: SettingDef = {
    key: "exec.shell", menu: "agents", label: "명령 실행 셸", description: "fixture description", keywords: "shell",
    kind: "enum", options: ["default", "sh"], min: null, max: null, default: "default",
    scopes: ["server", "project", "session"], applies: "next_turn", advanced: false,
};

function render(def: SettingDef = shell, target = { projectId: "p", sessionId: "s" }) {
    query.mockReturnValue({
        data: { items: [{
            key: def.key, default: def.default, effective: "sh", source: "project",
            layers: { server: { value: null, revision: 0 }, project: { value: "sh", revision: 2 }, session: { value: null, revision: 0 } },
        }] }, reload: vi.fn(),
    });
    return renderToStaticMarkup(createElement(ExecSettings, { defs: [def], target }));
}

describe("실행 설정의 기존 범위별 편집기 연결", () => {
    it("대화 대상을 고정하고 상속값·적용 시점을 표시한다", () => {
        const html = render();
        expect(query).toHaveBeenCalledWith("settings:s", expect.any(Function));
        expect(html).toContain('data-selected-value="session"');
        expect(html).toContain("명령 실행 셸 도움말");
        expect(html).not.toContain("fixture description");
        expect(html).toContain('data-selected-value="sh"');
        expect(html).toContain("다음 실행부터 적용");
        expect(html).toContain("파일·네트워크 접근은 제한하지 않아요");
    });

    it("지원하는 값만 표시하고 미지원 선택지 설명은 제공하지 않는다", () => {
        const html = render();
        expect(html).toContain('data-selected-value="sh"');
        expect(html).not.toContain("미지원 선택지");
        expect(html).not.toContain("cmd");
    });

    it("실행 설정만 분류하고 다른 설정을 전용 영역으로 옮기지 않는다", () => {
        expect(isExecSetting(shell)).toBe(true);
        for (const key of ["exec.max_memory_mb", "exec.max_cpu_seconds", "exec.default_cwd"]) {
            expect(isExecSetting({ ...shell, key })).toBe(false);
        }
        expect(isExecSetting({ ...shell, key: "exec.isolation" })).toBe(false);
        expect(isExecSetting({ ...shell, key: "output.style" })).toBe(false);
        expect(isExecSetting({ ...shell, key: "exec.unknown" })).toBe(false);
    });
});
