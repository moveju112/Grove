import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallRow } from "../../api/generated";
import { HookExecutions } from "./HookExecutions";

const query = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown, loading: false }));
vi.mock("../../state/store", () => ({ useQuery: () => ({ ...query, reload: () => {} }) }));
vi.mock("../ui/Controls", () => ({
    DetailDialog: ({ title, children }: { title: import("react").ReactNode; children: import("react").ReactNode }) => createElement("section", null, title, children),
}));
const call = {
    id: "hook-request", session_id: "session-fixture", name: "hook", status: "pending_approval", revision: 1,
    needs_approval: true, expires_at: null, target: {
        event: "Stop", hook_revision: 3, command: "<script>fixture</script>", cwd: "/fixture",
        environment: { PATH: "/usr/bin:/bin" }, limits: { memory_mb: 100 }, timeout_ms: 1000,
    }, result: {},
} as unknown as ToolCallRow;
const render = (projectId?: string) => renderToStaticMarkup(createElement(HookExecutions, { projectId }));

beforeEach(() => { query.data = [call]; query.error = null; query.loading = false; });
describe("hook 전용 승인·결과 화면", () => {
    it("기존 ApprovalCard로 이번만 승인·거부를 제공하고 고정 계획을 escape하여 표시한다", () => {
        const html = render();
        expect(html).toContain("이번만 승인");
        expect(html).toContain("거부");
        expect(html).not.toContain("이 대화에서 계속 허용");
        expect(html).toContain("매 이벤트마다 새 계획 승인");
        expect(html).toContain("hook_revision");
        expect(html).toContain("environment");
        expect(html).toContain("limits");
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
        expect(html).toContain("모든 프로젝트");
        expect(render("project")).toContain("현재 프로젝트");
    });
    it("running만 취소를 제공하고 unknown은 재실행 없이 기존 검토로 안내한다", () => {
        query.data = [{ ...call, status: "running" }];
        expect(render()).toContain("hook 실행 취소");
        query.data = [{ ...call, status: "unknown", result: { error: { code: "server_restart" } } }];
        const html = render();
        expect(html).toContain("결과 불명");
        expect(html).toContain("자동 반복하지 않습니다");
        expect(html).toContain("관찰·검토");
        expect(html).not.toContain("hook 실행 취소");
        expect(html).not.toContain(">이번만 승인</button>");
    });
    it("조회 오류·진행·빈 목록을 숨기지 않는다", () => {
        query.data = []; query.error = new Error("denied");
        expect(render()).toContain('role="alert"');
        query.error = null; query.loading = true;
        expect(render()).toContain("불러오는 중");
        query.loading = false;
        expect(render()).toContain("접수된 hook 실행 요청이 없습니다");
    });
});
