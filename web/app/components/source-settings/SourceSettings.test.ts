import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceSettings } from "./SourceSettings";
import { getSourceSettings } from "../../api/sourceSettings";

const { query, get } = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }));
vi.mock("../../state/store", () => ({ useQuery: query }));
vi.mock("../../api/client", () => ({ api: { get } }));
afterEach(() => vi.clearAllMocks());

describe("인증된 원본 설정 조회 연결", () => {
    it("typed 조회는 프로젝트 식별자만 인코딩하고 전역 조회에는 경로를 보내지 않는다", async () => {
        get.mockResolvedValue({ items: [] });
        await getSourceSettings();
        expect(get).toHaveBeenLastCalledWith("/source-settings");
        await getSourceSettings("p/with &symbols");
        expect(get).toHaveBeenLastCalledWith("/source-settings?project_id=p%2Fwith+%26symbols");
    });

    it("프로젝트별 cache 키와 조회 대상이 일치한다", async () => {
        query.mockReturnValue({ loading: false, error: null, data: { items: [] }, reload: vi.fn() });
        renderToStaticMarkup(createElement(SourceSettings, { projectId: "project-a" }));
        const [keyA, fetchA] = query.mock.lastCall!;
        await fetchA();
        expect(get).toHaveBeenLastCalledWith("/source-settings?project_id=project-a");
        renderToStaticMarkup(createElement(SourceSettings, { projectId: "project-b" }));
        const [keyB, fetchB] = query.mock.lastCall!;
        await fetchB();
        expect(get).toHaveBeenLastCalledWith("/source-settings?project_id=project-b");
        expect(keyA).not.toBe(keyB);
    });

    it("API 리소스 목록을 원본 출처에 연결한다", () => {
        query.mockReturnValue({
            loading: false, error: null, reload: vi.fn(),
            data: {
                items: [{ source: "codex_project", status: "missing" }],
                resources: [{
                    source: "codex_project", kind: "skills", relative_path: ".agents/skills",
                    result: { status: "present", ignored_invalid_entries: false, entries: [{
                        name: "source-skill", description: "Source description", relative_path: ".agents/skills/source-skill/SKILL.md",
                    }] },
                }],
            },
        });
        const html = renderToStaticMarkup(createElement(SourceSettings, { projectId: "project-a" }));
        expect(html).toContain("Source description");
        expect(html).toContain(".agents/skills/source-skill/SKILL.md");
    });

    it("실패 시 오래된 결과와 서버 오류 본문을 표시하지 않는다", () => {
        query.mockReturnValue({
            loading: false, error: new Error("source-private-marker"),
            data: { items: [{ source: "claude_project", status: "present", projection: { cleanupPeriodDays: 123456 }, ignored_invalid_fields: false }] },
            reload: vi.fn(),
        });
        const html = renderToStaticMarkup(createElement(SourceSettings, { projectId: "project-a" }));
        expect(html).toContain("원본 출처 목록을 가져오지 못했습니다");
        expect(html).toContain("소유자 권한이 필요합니다");
        expect(html).not.toContain("source-private-marker");
        expect(html).not.toContain("123456");
    });

    it("첫 렌더와 재조회 중에는 파일 부재 대신 로딩을 표시한다", () => {
        for (const loading of [false, true]) {
            query.mockReturnValue({ loading, error: null, data: undefined, reload: vi.fn() });
            const html = renderToStaticMarkup(createElement(SourceSettings));
            expect(html).toContain("원본 출처를 확인하는 중입니다");
            expect(html).not.toContain("원본 파일 또는 출처 디렉터리가 없습니다");
        }
    });
});
