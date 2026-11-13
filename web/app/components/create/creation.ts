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

type ProjectRequest = { path: "/projects" | "/projects/clone"; body: Record<string, unknown>; key: string };

// 폴더 등록과 clone은 하나의 생성 잠금·미확정 요청을 공유한다.
export class ProjectCreation {
    busy = false;
    pending: ProjectRequest | null = null;

    async run(path: ProjectRequest["path"], body: ProjectRequest["body"]): Promise<Project | undefined> {
        if (this.busy) return undefined;
        const fields = path === "/projects" ? ["root_path", "create"] : ["repo", "target_directory", "protocol"];
        const pending = this.pending;
        if (pending && (pending.path !== path || fields.some((field) => pending.body[field] !== body[field]))) {
            throw new Error("이전 생성 요청의 결과를 먼저 확인하세요.");
        }
        const request = this.pending ?? { path, body: structuredClone(body), key: newKey() };
        this.pending = request;
        this.busy = true;
        try {
            const result = path === "/projects"
                ? await api.post<Project>(path, request.body, { key: request.key })
                : (await api.post<{ project: Project }>(path, request.body, { key: request.key })).project;
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
