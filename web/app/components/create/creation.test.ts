import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, newKey } from "../../api/client";
import type { Project } from "../../api/generated";
import * as L from "../../state/layout";
import { CreationEntry } from "./CreationEntry";
import { CreationRequest, currentProjectId, projectTarget, ProjectCreation } from "./creation";

vi.mock("../../api/client", () => ({
    ApiError: class extends Error {
        constructor(public status: number, public code: string, message: string, public retryable = false, public details?: unknown) { super(message); }
    },
    api: { post: vi.fn(), patch: vi.fn() },
    newKey: vi.fn(),
}));

const a = { id: "a", name: "프로젝트 A", available: true } as Project;
const b = { id: "b", name: "프로젝트 B", available: true } as Project;
beforeEach(() => {
    vi.resetAllMocks();
    let key = 0;
    vi.mocked(newKey).mockImplementation(() => `create-${++key}`);
});

describe("공통 생성 진입", () => {
    it.each(["project", "session", "file", "settings"] as const)("%s 탭의 프로젝트 맥락을 유지한다", (kind) => {
        const layout = L.openResource(L.emptyLayout(), { kind, project_id: a.id, title: "현재" });
        expect(currentProjectId(layout)).toBe(a.id);
    });
    it("전역 화면·빈 배치는 프로젝트를 임의로 고르지 않는다", () => {
        expect(currentProjectId()).toBeUndefined();
        expect(currentProjectId(L.emptyLayout())).toBeUndefined();
        expect(currentProjectId(L.openResource(L.emptyLayout(), { kind: "settings", title: "설정" }))).toBeUndefined();
    });
    it("현재 pane의 활성 탭만 맥락으로 쓰며 생성 진입은 기존 프로젝트 탭을 재사용한다", () => {
        let layout = L.openResource(L.emptyLayout(), projectTarget(a));
        const original = L.focusedLeaf(layout).active_tab;
        layout = L.splitLeaf(layout, layout.focused_leaf, "row", projectTarget(b));
        expect(currentProjectId(layout)).toBe(b.id);
        layout = L.openResource(layout, projectTarget(a));
        layout = L.openResource(layout, projectTarget(a));
        expect(L.focusedLeaf(layout).active_tab).toBe(original);
        expect(L.allTabs(layout)).toHaveLength(2);
        expect(api.post).not.toHaveBeenCalled();
    });
    it("전역 +는 프로젝트·폴더 추가용이며 대화 선택이나 서버 생성을 시작하지 않는다", () => {
        const html = renderToStaticMarkup(createElement(CreationEntry, {
            foldersSupported: true, onTrigger: vi.fn(), onAddProject: vi.fn(), onAddFolder: vi.fn(),
        }));
        expect(html).toContain('aria-label="프로젝트·폴더 추가"');
        expect(html).not.toContain("새 대화");
        expect(html).not.toContain("대화 프로젝트 선택");
        expect(api.post).not.toHaveBeenCalled();
    });
});

describe("정리용 폴더 요청", () => {
    it("생성 응답 유실 뒤에는 같은 이름·같은 요청 키로만 확인한다", async () => {
        const folder = { id: "folder", name: "Work" };
        vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(folder);
        const request = new CreationRequest<typeof folder>();
        await expect(request.run("/project-folders", { name: "Work" })).rejects.toThrow("response lost");
        await expect(request.run("/project-folders", { name: "Other" })).rejects.toThrow("먼저 확인");
        expect(await request.run("/project-folders", { name: "Work" })).toEqual(folder);
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
        expect(vi.mocked(api.post).mock.calls[0]![2]?.requires).toEqual(["project_folders_v1"]);
    });
    it("이름 변경도 원래 revision과 키를 보존한다", async () => {
        vi.mocked(api.patch).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ id: "folder" });
        const request = new CreationRequest<{ id: string }>("patch");
        const body = { name: "Next", expected_revision: 3 };
        await expect(request.run("/project-folders/folder", body)).rejects.toThrow("response lost");
        await expect(request.run("/project-folders/folder", { ...body, expected_revision: 4 })).rejects.toThrow("먼저 확인");
        expect(await request.run("/project-folders/folder", body)).toEqual({ id: "folder" });
        expect(vi.mocked(api.patch).mock.calls[1]).toEqual(vi.mocked(api.patch).mock.calls[0]);
    });
    it("폴더 이동 응답이 유실되면 같은 폴더와 revision, 요청 키로 확인한다", async () => {
        vi.mocked(api.patch).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(a);
        const request = new CreationRequest<Project, `/projects/${string}`>("patch");
        const body = { expected_revision: 3, folder_id: null };
        await expect(request.run("/projects/a", body)).rejects.toThrow("response lost");
        await expect(request.run("/projects/a", { ...body, folder_id: "other" })).rejects.toThrow("먼저 확인");
        expect(await request.run("/projects/a", body)).toEqual(a);
        expect(vi.mocked(api.patch).mock.calls[1]).toEqual(vi.mocked(api.patch).mock.calls[0]);
        expect(vi.mocked(api.patch).mock.calls[0]![2]?.requires).toEqual(["project_folders_v1"]);
    });
});

describe("프로젝트 생성 잠금·재확인", () => {
    const body = { root_path: "/work/project" };
    it("동일 tick의 중복 등록·clone을 하나의 요청으로 제한한다", async () => {
        let finish!: (project: Project) => void;
        vi.mocked(api.post).mockImplementation(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
        const creation = new ProjectCreation();
        const first = creation.run("/projects", body);
        expect(creation.busy).toBe(true);
        expect(await creation.run("/projects", body)).toBeUndefined();
        expect(await creation.run("/projects/clone", { repo: "a/b" })).toBeUndefined();
        expect(api.post).toHaveBeenCalledTimes(1);
        finish(a);
        expect(await first).toEqual(a);
        expect(creation.busy).toBe(false);
        expect(creation.pending).toBeNull();
    });
    it.each([
        new Error("response lost"),
        new ApiError(503, "unavailable", "서버 오류"),
        new ApiError(408, "timeout", "시간 초과"),
        new ApiError(409, "unknown", "결과 미확정", false, { result_unknown: true }),
    ])("미확정 오류 뒤 원래 본문·키만 다시 사용한다: %s", async (error) => {
        vi.mocked(api.post).mockRejectedValueOnce(error).mockResolvedValueOnce(a);
        const creation = new ProjectCreation();
        await expect(creation.run("/projects", body)).rejects.toBe(error);
        await expect(creation.run("/projects", { root_path: "/work/other" })).rejects.toThrow("먼저 확인");
        await expect(creation.run("/projects/clone", { repo: "a/b" })).rejects.toThrow("먼저 확인");
        expect(api.post).toHaveBeenCalledTimes(1);
        expect(await creation.run("/projects", { ...body })).toEqual(a);
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
        expect(newKey).toHaveBeenCalledTimes(1);
    });
    it("명확한 권한 오류는 변경 요청을 허용하되 자동 재시도하지 않는다", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "forbidden", "권한 없음")).mockResolvedValueOnce(a);
        const creation = new ProjectCreation();
        await expect(creation.run("/projects", body)).rejects.toThrow("권한 없음");
        expect(creation.pending).toBeNull();
        expect(api.post).toHaveBeenCalledTimes(1);
        await creation.run("/projects", { root_path: "/work/other" });
        expect(vi.mocked(api.post).mock.calls[1]![2]?.key).not.toBe(vi.mocked(api.post).mock.calls[0]![2]?.key);
    });
    it("clone도 같은 잠금과 재확인 키를 쓰고 기존 응답의 project를 반환한다", async () => {
        const clone = { repo: "owner/repo", target_directory: "/work", protocol: "https" };
        vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ project: b });
        const creation = new ProjectCreation();
        await expect(creation.run("/projects/clone", clone)).rejects.toThrow("response lost");
        expect(await creation.run("/projects/clone", clone)).toEqual(b);
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
    });
    it("본문 필드 순서가 달라도 같은 생성 요청으로 확인한다", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ project: a });
        const creation = new ProjectCreation();
        await expect(creation.run("/projects/clone", { repo: "owner/repo", target_directory: "/work", protocol: "https" })).rejects.toThrow("response lost");
        expect(await creation.run("/projects/clone", { protocol: "https", target_directory: "/work", repo: "owner/repo" })).toEqual(a);
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
    });
});
