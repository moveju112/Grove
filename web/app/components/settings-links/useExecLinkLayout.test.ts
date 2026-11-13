import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useExecLinkLayout } from "./useExecLinkLayout";

const { queries, query } = vi.hoisted(() => ({
    queries: new Map<string, { data: unknown; error: unknown; loading: boolean }>(),
    query: vi.fn(),
}));
vi.mock("../../state/store", () => ({ useQuery: query }));

function render(active = true, mcpSupported: boolean | null = true, projectId?: string) {
    function Probe() {
        return String(useExecLinkLayout(active, projectId, mcpSupported));
    }
    return renderToStaticMarkup(createElement(Probe));
}

beforeEach(() => {
    queries.clear();
    query.mockReset();
    query.mockImplementation((key: string | null) => key === null
        ? { data: undefined, error: null, loading: false }
        : queries.get(key) ?? { data: [], error: null, loading: false });
});

describe("exec 앞쪽 비동기 메뉴의 최초 렌더 준비", () => {
    const keys = ["definitions:agent", "source-settings:null", "hooks:global", "profiles", "mcp", "secrets"];
    it("기존 조회들이 준비됐으면 이동을 허용한다", () => {
        expect(render()).toBe("true");
        expect(query.mock.calls.map(([key]) => key)).toEqual(keys);
    });
    it("각 앞쪽 조회의 초기 요청·재조회가 끝나기 전에는 이동을 보류한다", () => {
        for (const key of keys) {
            for (const state of [
                { data: undefined, error: null, loading: false },
                { data: undefined, error: null, loading: true },
                { data: [], error: null, loading: true },
            ]) {
                queries.set(key, state);
                expect(render()).toBe("false");
            }
            queries.delete(key);
        }
    });
    it("다른 영역의 조회 오류는 기존 오류 화면이 렌더되는 완료 상태이며 무한 대기하지 않는다", () => {
        for (const key of keys) queries.set(key, { data: undefined, error: new Error("fixture"), loading: false });
        expect(render()).toBe("true");
    });
    it("미지원 MCP의 조회를 시작하거나 기다리지 않는다", () => {
        queries.set("mcp", { data: undefined, error: null, loading: false });
        queries.set("secrets", { data: undefined, error: null, loading: false });
        expect(render(true, false)).toBe("true");
        expect(query.mock.calls.map(([key]) => key)).toEqual([...keys.slice(0, 4), null, null]);
    });
    it("프로젝트별 원본 cache를 공유하며 완료·취소·다른 링크에서는 추가 구독하지 않는다", () => {
        queries.set('source-settings:"project-a"', { data: undefined, error: null, loading: true });
        expect(render(true, null, "project-a")).toBe("false");
        expect(render(true, null, "project-b")).toBe("true");
        query.mockClear();
        expect(render(false)).toBe("true");
        expect(query.mock.calls.every(([key]) => key === null)).toBe(true);
    });
});
