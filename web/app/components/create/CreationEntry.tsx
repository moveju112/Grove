import { createContext } from "react";
import type { Project } from "../../api/generated";
import { CreationDialog } from "./CreationDialog";

export const CreationFocus = createContext<{ tabId: string; narrow: boolean; version: number } | null>(null);

export function CreationEntry({ projects, currentId, loading, error, blockedReason, onReload, onSelect, onAddProject, onClose }: {
    projects: Project[]; currentId?: string; loading: boolean; error: boolean;
    blockedReason?: string | null;
    onReload: () => void; onSelect: (project: Project) => void; onAddProject: () => void; onClose: () => void;
}) {
    const current = projects.find((project) => project.id === currentId);
    return <CreationDialog label="만들기" onClose={onClose}>
        <h2>새 대화</h2>
        <p className="muted small">프로젝트 입력창에서 메시지를 보내면 대화가 만들어집니다. 기존 입력은 유지합니다.</p>
        {blockedReason && <p className="warn" role="status" data-testid="creation-blocked">{blockedReason} 프로젝트 선택·초안 편집·취소는 계속 사용할 수 있습니다.</p>}
        {loading && <p role="status">프로젝트 확인 중…</p>}
        {error && <p className="err" role="alert">프로젝트를 불러오지 못했습니다. <button onClick={onReload}>다시 확인</button></p>}
        {currentId ? <>
            {current ? <>
                <p>현재 프로젝트: {current.name}</p>
                {!current.available && <p className="warn" role="status">프로젝트 경로 없음</p>}
                <button disabled={!current.available || error || loading} onClick={() => onSelect(current)}>이 프로젝트에서 새 대화</button>
            </> : !loading && !error && <p className="err" role="alert">현재 프로젝트를 확인할 수 없습니다. 다른 프로젝트로 자동 전환하지 않습니다.</p>}
        </> : <>
            <p>대화를 시작할 프로젝트를 선택하세요.</p>
            <ul className="dir-list" aria-label="대화 프로젝트 선택">
                {projects.map((project) => <li key={project.id}>
                    <button className="link" disabled={!project.available || error || loading} onClick={() => onSelect(project)}>
                        {project.name}{!project.available && " (경로 없음)"}
                    </button>
                </li>)}
            </ul>
            {!loading && !error && projects.length === 0 && <p role="status">먼저 프로젝트를 추가하세요.</p>}
        </>}
        <div className="row">
            <button className="ghost" onClick={onAddProject}>프로젝트 추가</button>
            <button className="ghost" onClick={onClose}>취소</button>
        </div>
    </CreationDialog>;
}
