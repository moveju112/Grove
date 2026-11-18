import { ApiError, api, newKey } from "../../api/client";
import type { Project } from "../../api/generated";
import * as L from "../../state/layout";

export function currentProjectId(layout?: L.Layout): string | undefined {
    if (!layout) return undefined;
    const leaf = L.focusedLeaf(layout);
    return leaf.tabs.find((tab) => tab.id === leaf.active_tab)?.project_id;
}

export function projectTarget(project: Pick<Project, "id" | "name">) {
    return { kind: "project" as const, project_id: project.id, resource_id: project.id, title: project.name };
}

type CreationPath = "/projects" | "/projects/clone" | `/projects/${string}` | "/project-folders" | `/project-folders/${string}`;
type ProjectRequest<P extends CreationPath> = { path: P; body: Record<string, unknown>; key: string };

// 프로젝트·폴더 변경은 원래 본문과 키를 보관하고 결과 불명일 때 다른 요청으로 바꾸지 않는다.
export class CreationRequest<T = Project, P extends CreationPath = CreationPath> {
    busy = false;
    pending: ProjectRequest<P> | null = null;
    constructor(private method: "post" | "patch" = "post") {}

    async run(path: P, body: Record<string, unknown>): Promise<T | undefined> {
        if (this.busy) return undefined;
        // 고정 엔드포인트는 generic template 경로의 narrowing과 분리해서 판별한다.
        const endpoint: string = path;
        const fields = endpoint === "/projects" ? ["root_path"] : endpoint === "/projects/clone"
            ? ["repo", "target_directory", "protocol"] : ["name", "expected_revision", "folder_id"];
        const pending = this.pending;
        if (pending && (pending.path !== path || fields.some((field) => pending.body[field] !== body[field]))) {
            throw new Error("이전 요청의 결과를 먼저 확인하세요.");
        }
        const request = this.pending ?? { path, body: structuredClone(body), key: newKey() };
        this.pending = request;
        this.busy = true;
        try {
            const options = { key: request.key, requires: path.startsWith("/project-folders") || "folder_id" in request.body ? ["project_folders_v1"] : undefined };
            const result = endpoint === "/projects/clone"
                ? (await api.post<{ project: T }>(path, request.body, options)).project
                : this.method === "patch" ? await api.patch<T>(path, request.body, options)
                : await api.post<T>(path, request.body, options);
            this.pending = null;
            return result;
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            if (!unknown) this.pending = null;
            throw e;
        } finally {
            this.busy = false;
        }
    }
}

export class ProjectCreation extends CreationRequest<Project, "/projects" | "/projects/clone"> {}
