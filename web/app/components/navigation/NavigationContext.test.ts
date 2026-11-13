import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Session } from "../../api/generated";
import type { Layout } from "../../state/layout";
import { useQuery } from "../../state/store";
import { NavigationContext, type NavigationContextProps } from "./NavigationContext";

vi.mock("../../state/store", () => ({ useQuery: vi.fn() }));

const layout: Layout = { schema: 1, focused_leaf: "pane", root: {
    type: "leaf", id: "pane", active_tab: "tab", tabs: [
        { id: "tab", kind: "session", project_id: "p", resource_id: "s", title: "古いタイトル" },
    ],
} };
const project = { id: "p", name: "<프로젝트>" } as Project;
const session = { id: "s", project_id: "p", title: "<현재 대화>" } as Session;
const render = (overrides: Partial<NavigationContextProps> = {}) => renderToStaticMarkup(createElement(NavigationContext, {
    layout, projects: [project], host: "https://user:private-password@host.test:8443/path?token=private-query#private-fragment",
    open: vi.fn(), onBrowseProjects: vi.fn(), sidebarOpen: false, ...overrides,
}));

beforeEach(() => {
    vi.mocked(useQuery).mockReturnValue({ data: session, error: null, loading: false, reload: vi.fn() });
});

describe("현재 위치의 접근성·오류 표시", () => {
    it("현재 페이지와 실제 ID를 명시하고 호스트 전환 링크나 비밀을 만들지 않는다", () => {
        const html = render();
        expect(html).toContain('aria-label="현재 위치"');
        expect(html).toContain('aria-current="page"');
        expect(html).toContain('data-project-id="p" data-session-id="s"');
        expect(html).toContain("host.test:8443");
        expect(html).not.toMatch(/private-|<a /);
        expect(html).toContain("&lt;현재 대화&gt;");
        expect(html).toContain("&lt;프로젝트&gt;");
        expect(html).not.toContain("古いタイトル");
        expect(html).toContain('aria-label="프로젝트 탐색" aria-expanded="false"');
    });
    it("조회 실패를 알려도 다른 세션 이름이나 서버 오류 내용을 노출하지 않는다", () => {
        vi.mocked(useQuery).mockReturnValue({ data: { ...session, id: "old" }, error: new Error("private-error"), loading: false, reload: vi.fn() });
        const html = render();
        expect(html).toContain("세션 s");
        expect(html).toContain("조회 실패");
        expect(html).not.toContain("&lt;현재 대화&gt;");
        expect(html).not.toContain("private-error");
    });
    it("전역 설정에서는 이전 프로젝트·세션이 남지 않는다", () => {
        const html = render({ layout: { ...layout, root: { type: "leaf", id: "pane", active_tab: "settings",
            tabs: [{ id: "settings", kind: "settings", title: "설정" }] } } });
        expect(html).toContain(">설정</span>");
        expect(html).not.toContain("data-project-id");
        expect(html).not.toContain("data-session-id");
        expect(html).not.toContain("&lt;현재 대화&gt;");
    });
    it("긴 이름 전체를 접근성 이름과 tooltip에 남긴다", () => {
        const name = "긴이름".repeat(100);
        const html = render({ projects: [{ ...project, name }] });
        expect(html).toContain(`aria-label="프로젝트: ${name} (p) 대화 목록으로"`);
        expect(html).toContain(`title="프로젝트: ${name} (p) 대화 목록으로"`);
    });
    it("배치 로딩·빈 pane을 구분한다", () => {
        expect(render({ layout: undefined })).toContain("배치 불러오는 중…");
        expect(render({ layout: { ...layout, root: { type: "leaf", id: "pane", active_tab: null, tabs: [] } } })).toContain("빈 영역");
    });
});
