import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hookPath, hookUpdate, type Hook, type HookListing } from "../../api/hooks";
import { HooksSettings } from "./HooksSettings";

const query = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown, loading: false }));
vi.mock("../../state/store", () => ({ useQuery: (key: string) => ({
    ...query, data: key.startsWith("recovery:hook-executions:") ? [] : query.data, reload: () => {},
}) }));
const hook: Hook = {
    id: "h1", project_id: null, name: "<script>hook</script>", event: "PreToolUse", matcher: "shell*",
    command: "[redacted]", command_redacted: true, enabled: true, revision: 3, execution_state: "not_implemented",
};
const listing: HookListing = { hooks: [hook], events: ["PreToolUse", "Stop"], matcher_syntax: "glob", execution_state: "not_implemented" };
const render = (projectId?: string) => renderToStaticMarkup(createElement(HooksSettings, { projectId, projectName: "project" }));

beforeEach(() => { query.data = listing; query.error = null; query.loading = false; });
describe("hook 설정·실행 지원 계약", () => {
    it("지원 이벤트와 개별 승인·취소 경계를 짧게 표시한다", () => {
        query.data = { ...listing, supported_events: ["SessionStart", "Stop"],
            hooks: [{ ...hook, event: "Stop", execution_state: "approval_required" }] };
        const html = render();
        expect(html).toContain("이벤트 발생 후 개별 승인 필요");
        expect(html).toContain("SessionStart, Stop");
        expect(html).toContain("저장·활성화는 실행 승인이 아닙니다");
        expect(html).toContain("연결 종료는 취소가 아닙니다");
        expect(html).toContain("실행 요청에서 취소·결과를 확인하세요");
    });
    it("서버의 이벤트·활성 설정과 미실행 상태를 표시하고 HTML을 escape한다", () => {
        const html = render();
        expect(html).toContain("아직 실행되지 않음");
        expect(html).toContain("활성 설정");
        expect(html).toContain("revision 3");
        expect(html).toContain("명령 전체를 가렸습니다");
        expect(html).toContain("&lt;script&gt;hook&lt;/script&gt;");
        expect(html).not.toContain("<script>");
        expect(html).toContain('<option value="global"');
        expect(html).not.toContain('<option value="project"');
        expect(html).toContain("<option>Stop</option>");
    });
    it("프로젝트 context가 있을 때만 해당 범위를 제공한다", () => {
        expect(render("p1")).toContain('<option value="project"');
    });
    it("목록 오류·로딩·빈 상태를 명시한다", () => {
        query.data = undefined; query.error = new Error("소유자 권한이 필요합니다");
        expect(render()).toContain('role="alert"');
        expect(render()).toContain("소유자 권한");
        query.error = null; query.loading = true;
        expect(render()).toContain("불러오는 중");
        query.loading = false; query.data = { ...listing, hooks: [] };
        expect(render()).toContain("저장한 hook이 없습니다");
    });
    it("scope·revision은 URL에 명시하고 특수 문자를 인코딩한다", () => {
        expect(hookPath()).toBe("/hooks");
        expect(hookPath("p & 1", "h/1", 3)).toBe("/hooks/h%2F1?project_id=p+%26+1&expected_revision=3");
    });
    it("비활성화·일반 편집은 가려진 명령을 보내지 않고 명시적 교체만 보낸다", () => {
        const draft = { name: hook.name, event: "Stop", matcher: "*", command: "printf replacement", enabled: false };
        expect(hookUpdate(hook, draft, false)).toEqual({
            name: hook.name, event: "Stop", matcher: "*", enabled: false, expected_revision: 3,
        });
        expect(hookUpdate(hook, draft, true).command).toBe("printf replacement");
        expect(hookUpdate(hook, { ...hook, enabled: false }, false)).toEqual({
            name: hook.name, event: hook.event, matcher: hook.matcher, enabled: false, expected_revision: 3,
        });
    });
});
