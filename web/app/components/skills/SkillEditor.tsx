import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import type { SkillMutation, SkillSelection } from "../../api/skills";
import { HelpTip, SentenceText } from "../HelpTip";
import { TextInput, TextArea } from "../../design/Fields";
import { Select } from "../../design/Select";

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
    return <GroveStack as="form" gap={2} aria-label="Grove 스킬 편집" onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit(draftMutation(draft));
    }}>
        <GroveHeading level={4} color="inherit"><GroveStack as="span" direction="horizontal" align="center" gap={1.5}>{draft.kind === "add" ? "Grove 스킬 추가" : "Grove 스킬 본문 저장"} <HelpTip label="스킬 편집 도움말">
            <SentenceText text="UTF-8 최대 64 KiB이며 원본 Claude/Codex 정의는 변경하지 않습니다. 저장·활성화·다시 읽기는 기존 선택을 갱신하지 않으므로, 변경된 선택은 해제한 뒤 본문을 확인하고 다시 선택하세요." />
        </HelpTip></GroveStack></GroveHeading>
        {draft.kind === "add" ? <>
            <Select label="저장 범위" value={draft.scope} disabled={busy}
                onChange={(value) => onChange({ ...draft, scope: value as "global" | "project" })}
                options={[{ value: "project", label: "현재 프로젝트 실행 root" }, { value: "global", label: "Grove 전역" }]} />
            <TextInput label="스킬 이름" value={draft.name} maxLength={128} isRequired isDisabled={busy}
                onChange={(value) => onChange({ ...draft, name: value })} />
        </> : <GroveText as="p" display="block" type="supporting" color="secondary">편집 기준 revision <code>{draft.selection.revision}</code></GroveText>}
        <TextArea label="스킬 본문" value={draft.text} rows={10} isDisabled={busy}
            onChange={(value) => onChange({ ...draft, text: value })} />
        <GroveStack direction="horizontal" align="center" gap={1.5}>
            <GroveButton type="submit" disabled={busy || (draft.kind === "add" && !draft.name.trim())}>스킬 저장</GroveButton>
            <GroveButton type="button" variant="secondary" disabled={busy} onClick={onCancel}>초안 닫기</GroveButton>
        </GroveStack>
    </GroveStack>;
}
