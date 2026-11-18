import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOverviewData } from "../../api/agentOverview";
import { getAgentOverview } from "../../api/agentOverview";
import { AgentOverview } from "./AgentOverview";

const { state, get, live } = vi.hoisted(() => ({ state: vi.fn(), get: vi.fn(), live: { status: "live" } }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: state }));
vi.mock("../../state/store", () => ({ useLive: () => live.status, subscribeQuery: vi.fn() }));
vi.mock("../../api/client", () => ({ api: { get } }));
// 열기·초점은 브라우저 검사에서, 여기서는 열린 상세 내용의 데이터·escape 계약을 확인한다.
vi.mock("../ui/Controls", () => ({
    DetailDialog: ({ title, children }: { title: import("react").ReactNode; children: import("react").ReactNode }) => createElement("section", null, title, children),
}));
afterEach(() => { vi.clearAllMocks(); live.status = "live"; });
const data: AgentOverviewData = {
    project_id: "p", session_id: "s",
    roles: [{ id: "worker", name: "Worker", description: "실제 역할", body: "적용 지침 <script>안전한 텍스트</script>",
        builtin: true, execution: "orchestrated", modified_fields: ["body"], enabled: true, revision: 1, availability: "available" }],
    delegation: { mode: "ask", source: "project", approval: "ask" },
    parent: { status: "active", profile: { status: "configured", name: "부모 모델", model: "parent" }, tools_enabled: true },
    next_request_default: { status: "configured", name: "다음 모델", model: "next", source: "project" },
    limits: { max_depth: 2, max_per_parent: 4, max_running: 16 },
};
function render(value: AgentOverviewData = data, status = "ready", key = '["p","s"]') {
    state.mockImplementationOnce(() => [{ key, status, data: value }, vi.fn()]).mockImplementationOnce(() => [0, vi.fn()]);
    return renderToStaticMarkup(createElement(AgentOverview, { target: { projectId: "p", sessionId: "s" }, onEdit: vi.fn() }));
}

describe("역할 개요", () => {
    it("모델·실행 요약을 숨기고 역할 지침과 정책 상태를 표시한다", () => {
        const html = render();
        for (const text of ["역할 상세", "override 수정됨", "현재 정책상 사용 가능", "worker 기존 편집 열기"]) expect(html).toContain(text);
        for (const text of ["모델·실행 정보", "모델 연결", "부모 모델", "다음 모델", "위임 실행 규칙", "현재 대화의 시작 승인", "최대 깊이", "자동 재실행하지 않습니다"]) expect(html).not.toContain(text);
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
        expect(get).not.toHaveBeenCalled();
    });
    it("오류·로딩·다른 대상 cache는 이전 정보를 현재값으로 표시하지 않는다", () => {
        for (const [status, key] of [["error", '["p","s"]'], ["loading", '["p","s"]'], ["ready", '["other","s"]']]) {
            const html = render(data, status, key);
            expect(html).not.toContain("역할 worker");
            expect(html).not.toContain("적용 지침 &lt;script");
        }
    });
    it.each(["connecting", "reconnecting", "offline", "auth_expired"])("%s에서는 cache의 역할 지침을 현재값으로 표시하지 않는다", (status) => {
        live.status = status;
        const html = render();
        expect(html).toContain("연결 확인 중");
        expect(html).not.toContain("역할 worker");
        expect(html).not.toContain("적용 지침 &lt;script");
    });
    it("대화 대상이 프로젝트보다 우선하며 root나 다른 상태를 보내지 않는다", async () => {
        get.mockResolvedValue(data);
        await getAgentOverview({ projectId: "p", sessionId: "s" });
        expect(get).toHaveBeenLastCalledWith("/agent-overview?session_id=s");
        await getAgentOverview({ projectId: "p" });
        expect(get).toHaveBeenLastCalledWith("/agent-overview?project_id=p");
        await getAgentOverview({});
        expect(get).toHaveBeenLastCalledWith("/agent-overview?");
    });
});
