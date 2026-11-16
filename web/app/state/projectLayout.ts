import * as L from "./layout";
import { sha256Fallback } from "./sha256";

// 서버의 64자 기기 키 계약 안에서 프로젝트·화면 폭별 저장 수명을 구분한다.
export function projectLayoutKey(base: string, projectId: string): string {
    return `p-${sha256Fallback(new TextEncoder().encode(JSON.stringify([base, projectId]))).slice(0, 48)}${base.endsWith("-narrow") ? "-narrow" : ""}`;
}

// 이전 공용 배치에서 해당 프로젝트만 옮긴다. 탭 ID는 초안·스크롤 사본의 식별자이므로 유지한다.
export function projectLayout(legacy: L.Layout, projectId: string): L.Layout {
    const filter = (node: L.Node): L.Node => {
        if (node.type === "split") return { ...node, children: [filter(node.children[0]), filter(node.children[1])] };
        const tabs = node.tabs.filter((tab) => tab.project_id === projectId && tab.kind !== "settings");
        return { ...node, tabs, active_tab: tabs.some((tab) => tab.id === node.active_tab) ? node.active_tab : tabs[0]?.id ?? null };
    };
    return L.collapseEmpty({ ...legacy, root: filter(legacy.root) });
}
