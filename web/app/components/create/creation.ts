import { ApiError, api, authGeneration, newKey } from "../../api/client";
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
            ? ["repo", "target_directory", "protocol"] : ["name", "expected_revision", "folder_id", "icon", "icon_color", "icon_photo_base64"];
        const pending = this.pending;
        if (pending && (pending.path !== path || fields.some((field) => pending.body[field] !== body[field]))) {
            throw new Error("이전 요청의 결과를 먼저 확인하세요.");
        }
        const request = this.pending ?? { path, body: structuredClone(body), key: newKey() };
        this.pending = request;
        this.busy = true;
        try {
            const options = { key: request.key, requires: path.startsWith("/project-folders") || "folder_id" in request.body ? ["project_folders_v1"]
                : "icon_color" in request.body || "icon_photo_base64" in request.body ? ["project_icons_v1"] : undefined };
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

type TerminalTarget = { id: string; name: string };
const terminalRequests = new Map<string, CreationRequest<TerminalTarget>>();
let terminalOwner: number | undefined;

// 목록·단축키가 같은 터미널 생성 요청을 확인한다. 접수가 확정되면 다음 생성은 새 요청이다.
export async function createTerminal(projectId: string) {
    const owner = authGeneration();
    if (terminalOwner !== owner) { terminalRequests.clear(); terminalOwner = owner; }
    const request = terminalRequests.get(projectId) ?? new CreationRequest<TerminalTarget>();
    terminalRequests.set(projectId, request);
    try {
        const result = await request.run(`/projects/${projectId}/terminals`, { name: "터미널" });
        return owner === authGeneration() ? result : undefined;
    } catch (error) {
        if (request.pending) throw new Error("터미널 생성 응답을 받지 못했어요. 다시 누르면 같은 요청의 결과를 확인해요.");
        throw error;
    } finally {
        if (!request.pending && terminalRequests.get(projectId) === request) terminalRequests.delete(projectId);
    }
}
