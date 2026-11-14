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
        builtin: true, modified_fields: ["body"], enabled: true, revision: 1, availability: "available" }],
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
    it("실제 상속·다음 요청 기본값·override·정책·실행 미확인을 분리한다", () => {
        const html = render();
        for (const text of ["부모 모델", "다음 모델", "현재 부모 턴:", "도구 켜짐", "override 수정됨", "현재 정책상 사용 가능",
            "연결·실행 미확인", "최대 깊이 2", "동시 실행 4", "동시 실행 16", "자동 재실행하지 않습니다", "worker 기존 편집 열기"]) expect(html).toContain(text);
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
        expect(get).not.toHaveBeenCalled();
    });
    it.each(["unset", "missing", "disabled", "unknown"] as const)("모델 %s를 성공이나 첫 모델 연결로 표시하지 않는다", (status) => {
        const profile = status === "disabled" ? { status, name: "꺼진 모델", model: "off" } : { status };
        const html = render({ ...data, parent: { status: "no_active_turn" }, next_request_default: { ...profile, source: "server" } });
        expect(html).toContain(status === "unknown" ? "모델 상태 확인 불가" : "선택 필요");
        expect(html).not.toContain("연결·실행 미확인");
        expect(html).toContain("상속 모델 아직 미정");
    });
    it("오류·로딩·다른 대상 cache는 이전 정보를 현재값으로 표시하지 않는다", () => {
        for (const [status, key] of [["error", '["p","s"]'], ["loading", '["p","s"]'], ["ready", '["other","s"]']]) {
            const html = render(data, status, key);
            expect(html).not.toContain("부모 모델");
            expect(html).not.toContain("적용 지침 &lt;script");
        }
    });
    it.each(["connecting", "reconnecting", "offline", "auth_expired"])("%s에서는 cache의 모델·지침을 현재값으로 표시하지 않는다", (status) => {
        live.status = status;
        const html = render();
        expect(html).toContain("연결 확인 중");
        expect(html).not.toContain("부모 모델");
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
