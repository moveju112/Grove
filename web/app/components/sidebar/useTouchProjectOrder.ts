import type { Project } from "../../api/generated";
import { projectFolderDropAt, type ProjectDrop } from "../../state/projectOrder";
import { useTouchOrder } from "../useTouchOrder";

type Item = Pick<Project, "id" | "folder_id">;
const PROJECT_ROW = "[data-project-order-id]";

export function useTouchProjectOrder(enabled: boolean, projects: readonly Item[],
    canMoveToFolder: (sourceId: string, folderId: string | null) => boolean, onDrop: (source: string, target: ProjectDrop) => void) {
    return useTouchOrder<ProjectDrop>({
        enabled, selector: PROJECT_ROW,
        idFor: (row) => row.dataset.projectOrderId!,
        viewportFor: (row) => row.closest<HTMLElement>('[data-testid="sidebar-scroll"]'),
        targetAt: (g) => {
            const folderId = projectFolderDropAt(document.elementFromPoint(g.x, g.y));
            if (folderId !== undefined && canMoveToFolder(g.id, folderId)) return { kind: "folder", folderId };
            const source = projects.find((p) => p.id === g.id);
            if (!source) return null;
            for (const row of g.viewport.querySelectorAll<HTMLElement>(PROJECT_ROW)) {
                const id = row.dataset.projectOrderId!;
                if (id === g.id) continue;
                const project = projects.find((p) => p.id === id);
                if (!project || (source.folder_id ?? null) !== (project.folder_id ?? null)) continue;
                const box = row.getBoundingClientRect();
                if (g.x >= box.left && g.x <= box.right && g.y >= box.top && g.y <= box.bottom) {
                    // 행 가운데에서는 원래 이동 방향으로 자리를 바꾸고, 양 끝에서는 정확한 삽입 위치를 고른다.
                    const fraction = (g.y - box.top) / box.height;
                    const belowSource = !!(g.row.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
                    return { kind: "order", id, after: fraction > 0.75 || (fraction >= 0.25 && belowSource) };
                }
            }
            return null;
        },
        onDrop,
    });
}
