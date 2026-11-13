import type { SkillMutation, SkillSelection } from "../../api/skills";

export type SkillDraft =
    | { kind: "add"; scope: "global" | "project"; name: string; text: string }
    | { kind: "save"; selection: SkillSelection; text: string };
export type SkillEditorProps = {
    draft: SkillDraft;
    busy: boolean;
    onChange: (draft: SkillDraft) => void;
    onSubmit: (mutation: SkillMutation) => void;
    onCancel: () => void;
};

export function draftMutation(draft: SkillDraft): SkillMutation {
    if (draft.kind === "add") return { op: "add", scope: draft.scope, name: draft.name, text: draft.text };
    return { op: "save", selection: draft.selection, text: draft.text };
}

// revision은 편집 시작 시 고정한다. reload·충돌이 초안이나 expected binding을 바꾸지 않는다.
export function SkillEditor({ draft, busy, onChange, onSubmit, onCancel }: SkillEditorProps) {
    return <form className="stack" aria-label="Grove 스킬 편집" onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit(draftMutation(draft));
    }}>
        <h4>{draft.kind === "add" ? "Grove 스킬 추가" : "Grove 스킬 본문 저장"}</h4>
        {draft.kind === "add" ? <>
            <label>저장 범위<select value={draft.scope} disabled={busy}
                onChange={(event) => onChange({ ...draft, scope: event.target.value as "global" | "project" })}>
                <option value="project">현재 프로젝트 실행 root</option>
                <option value="global">Grove 전역</option>
            </select></label>
            <label>스킬 이름<input value={draft.name} maxLength={128} required disabled={busy}
                onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
        </> : <p className="muted small">편집 기준 revision <code>{draft.selection.revision}</code></p>}
        <label>스킬 본문<textarea value={draft.text} rows={10} disabled={busy}
            onChange={(event) => onChange({ ...draft, text: event.target.value })} /></label>
        <p className="muted small">UTF-8 최대 64 KiB. 저장·활성화·다시 읽기는 기존 세션 선택을 갱신하지 않습니다.
            변경된 선택은 해제한 뒤 본문을 확인하고 다시 선택하세요. 원본 Claude/Codex 정의는 변경하지 않습니다.</p>
        <div className="inline">
            <button type="submit" disabled={busy || (draft.kind === "add" && !draft.name.trim())}>스킬 저장</button>
            <button type="button" className="ghost" disabled={busy} onClick={onCancel}>초안 닫기</button>
        </div>
    </form>;
}
