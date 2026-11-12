import type { Label, Project } from "../api/generated";

/// 라벨 필터의 "라벨 없음" 선택값(PROJECT-008).
export const UNLABELLED = "__none__";

/// 필터 적용. 비어 있으면 전부, 아니면 선택한 라벨 중 하나라도 붙었거나 "라벨 없음"을 고른 경우 라벨이 없는 프로젝트.
/// 삭제된 라벨 id는 무시해 남은 선택이 목록을 비우지 않게 한다.
export function filterProjects(projects: Project[], selected: string[], labels: Label[]): Project[] {
    const live = selected.filter((id) => id === UNLABELLED || labels.some((l) => l.id === id));
    if (live.length === 0) return projects;
    return projects.filter((p) => (live.includes(UNLABELLED) && p.labels.length === 0) || p.labels.some((id) => live.includes(id)));
}
