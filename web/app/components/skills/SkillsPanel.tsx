import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import {
    bindingOf, sameSelection, sameSource, selectionStatus, sourceLabel,
    type SkillBody, type SkillListing, type SkillSelection,
} from "./types";
import { Requirements } from "./requirements/Requirements";
import { HelpTip, SentenceText } from "../HelpTip";

export type SkillsPanelProps = {
    listing: SkillListing | null;
    selected: readonly SkillSelection[];
    preview: SkillBody | null;
    loading: boolean;
    busy?: boolean;
    error?: string | null;
    onInspect: (selection: SkillSelection) => void;
    onSelect: (selection: SkillSelection) => void;
    onDeselect: (selection: SkillSelection) => void;
    onEdit?: (body: SkillBody) => void;
    onSetEnabled?: (selection: SkillSelection, enabled: boolean) => void;
};

const priorityLabel = {
    preferred: "우선 후보",
    shadowed: "상위 출처의 동명 후보 있음",
    conflict: "동일 우선순위 충돌 · 명시적 선택 필요",
    incomplete: "우선순위 미확정 · 상위/동급 후보 조회 실패",
};

// 본문은 실행 가능한 HTML/Markdown이나 파일 링크로 만들지 않고 텍스트로 표시한다.
// loading/error 동안 이전 props의 본문·선택 버튼을 재사용하지 않는다.
export function SkillsPanel({
    listing, selected, preview, loading, busy = false, error = null, onInspect, onSelect, onDeselect, onEdit, onSetEnabled,
}: SkillsPanelProps) {
    const blocked = loading || busy || Boolean(error);
    const entries = listing?.entries ?? [];
    const previewEntry = preview && entries.find((entry) => sameSelection(entry, preview.selection));
    const orphaned = selected.filter((selection) =>
        !entries.some((entry) => entry.id === selection.id && sameSource(entry.source, selection.source)));
    return <section className="stack" aria-label="스킬 탐색과 선택" aria-busy={loading || busy}>
        <GroveHeading level={3} color="inherit" className="inline">스킬 <HelpTip label="스킬 도움말">
            <GroveText as="p" display="block" type="inherit" color="inherit"><SentenceText text="직접 선택한 스킬만 다음 모델 호출에 적용합니다. 자동 매칭 없음. 본문 보기만으로는 적용하지 않으며, 호출 직전 출처·revision을 다시 검증합니다." /></GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit"><SentenceText text="프로젝트 .agents/skills/가 서버 데이터 디렉터리의 skills/보다 우선합니다. 동급 동명 항목은 충돌로 표시하며, 하위 후보도 직접 선택할 수 있습니다." /></GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit"><SentenceText text="이름은 디렉터리명이며 metadata는 해석하지 않습니다. requirements.grove.json version 1의 tools/platforms/skills만 검증합니다. alias는 같은 root의 동일 파일을 가리키는 symlink만 구분합니다." /></GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">동명 항목·alias를 바꾸거나 선택한 본문이 변경·삭제되면 기존 선택을 해제하고 다시 선택하세요.</GroveText>
        </HelpTip></GroveHeading>
        <GroveText as="p" display="block" type="supporting" color="secondary">스킬 선택은 도구 실행 승인이 아닙니다.</GroveText>
        {loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">스킬 목록·본문을 읽는 중…</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {!loading && !error && listing && entries.length === 0 && <GroveText as="p" display="block" type="inherit" color="inherit">허용된 출처에서 조회 가능한 스킬이 없습니다.</GroveText>}
        {!loading && !error && !listing && <GroveText as="p" display="block" type="inherit" color="secondary">스킬 목록이 아직 연결되지 않았습니다.</GroveText>}
        {listing && <ul className="session-list" aria-label="스킬 목록">
            {entries.map((entry) => {
                const status = selectionStatus(entry, selected);
                const prior = selected.find((selection) => selection.id === entry.id && sameSource(selection.source, entry.source));
                return <li key={entry.id} className="stack">
                    <strong>{entry.name}</strong>
                    <GroveText type="inherit" color="inherit">{entry.enabled === false ? "비활성 · 모델 적용 불가" : "활성"}</GroveText>
                    <GroveText type="supporting" color="secondary">{sourceLabel(entry.source)}</GroveText>
                    <GroveText type="supporting" color="inherit">{priorityLabel[entry.priority]}</GroveText>
                    {entry.conflicts.length > 0 && <GroveText type="supporting" color="inherit">동명 후보 {entry.conflicts.length}개 · 아래 목록의 출처로 구분하세요.</GroveText>}
                    {entry.symlink && <GroveText type="supporting" color="secondary">허용된 root 내부 symlink</GroveText>}
                    {entry.alias_of && <GroveText type="supporting" color="secondary">
                        alias · {entries.find((candidate) => candidate.id === entry.alias_of)?.name ?? entry.alias_of}
                    </GroveText>}
                    {entry.metadata === "opaque_front_matter" && <GroveText type="supporting" color="warning">front matter는 원문으로만 표시합니다.</GroveText>}
                    <GroveText type="supporting" color="secondary">revision <code>{entry.revision}</code></GroveText>
                    <GroveText type="inherit" color="inherit" role="status">{status === "selected" ? "선택됨 · 다음 모델 호출 직전 재검증" : status === "stale" ? "선택한 revision과 다름 · 다시 확인 필요" : "미선택"}</GroveText>
                    <Requirements report={entry.requirements} />
                    <GroveStack direction="horizontal" align="center" className="inline">
                        <GroveButton type="button" className="ghost small" disabled={blocked} onClick={() => onInspect(bindingOf(entry))}
                            aria-label={`${entry.name} · ${sourceLabel(entry.source)} 본문 보기`}>본문 보기</GroveButton>
                        {prior && <GroveButton type="button" className="ghost small" disabled={busy}
                            onClick={() => onDeselect({ ...prior, source: { ...prior.source } })}>선택 해제</GroveButton>}
                        {onSetEnabled && <GroveButton type="button" className="ghost small" disabled={blocked}
                            aria-label={`${entry.name} · ${sourceLabel(entry.source)} ${entry.enabled ? "비활성화" : "활성화"}`}
                            onClick={() => onSetEnabled(bindingOf(entry), !entry.enabled)}>{entry.enabled ? "비활성화" : "활성화"}</GroveButton>}
                    </GroveStack>
                </li>;
            })}
        </ul>}
        {!loading && listing && listing.issues.length > 0 && <div role="status" className="warn small">
            <GroveText as="p" display="block" type="inherit" color="inherit">일부 항목 조회 실패 · 아래 항목은 목록에서 제외됐습니다.</GroveText>
            <ul>{listing.issues.map((issue, index) => <li key={index}>
                {sourceLabel(issue.source)}{issue.name && ` · ${issue.name}`} · <code>{issue.code}</code>
            </li>)}</ul>
        </div>}
        {orphaned.length > 0 && <div className="warn small">
            <GroveText as="p" display="block" type="inherit" color="inherit">목록에서 사라진 선택이 있으며 자동 대체하지 않습니다.</GroveText>
            <ul>{orphaned.map((selection) => <li key={`${selection.id}:${selection.revision}`}>
                {sourceLabel(selection.source)} · <code>{selection.id}</code> · revision <code>{selection.revision}</code>
                <GroveButton type="button" className="ghost small" disabled={busy}
                    onClick={() => onDeselect({ ...selection, source: { ...selection.source } })}>이 선택 해제</GroveButton>
            </li>)}</ul>
        </div>}
        {preview && !loading && !error && !previewEntry && <GroveText as="p" display="block" type="inherit" color="warning" role="status">
            본문의 출처·revision이 목록과 달라 다시 조회해야 합니다.
        </GroveText>}
        {preview && previewEntry && !loading && !error && <div className="stack" aria-label="스킬 본문">
            <GroveHeading level={4} color="inherit">{previewEntry.name} · 읽기 전용 본문</GroveHeading>
            <GroveText as="p" display="block" type="supporting" color="secondary">{sourceLabel(previewEntry.source)} · revision <code>{preview.selection.revision}</code></GroveText>
            <Requirements report={preview.requirements ?? previewEntry.requirements} />
            <pre className="text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflow: "auto" }}>{preview.text}</pre>
            {onEdit && <GroveButton type="button" disabled={blocked || previewEntry.symlink}
                onClick={() => onEdit(preview)}>본문 편집</GroveButton>}
            {onEdit && previewEntry.symlink && <GroveText as="p" display="block" type="supporting" color="secondary">symlink는 조회만 가능하며 원본을 이 편집기로 저장하지 않습니다.</GroveText>}
            <GroveButton type="button" disabled={blocked || (preview.requirements ?? previewEntry.requirements)?.status === "blocked"
                || previewEntry.enabled === false || selectionStatus(previewEntry, selected) !== "none"
                || selected.some((selection) => !entries.some((entry) => sameSelection(entry, selection)))
                || selected.some((selection) => {
                    const other = entries.find((entry) => sameSelection(entry, selection));
                    return other && (other.name === previewEntry.name
                        || (other.alias_of ?? other.id) === (previewEntry.alias_of ?? previewEntry.id));
                })}
                onClick={() => onSelect(bindingOf(previewEntry))}>이 revision 선택 · 다음 모델 호출에 적용</GroveButton>
        </div>}
    </section>;
}
