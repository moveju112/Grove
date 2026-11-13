import {
    bindingOf, sameSelection, sameSource, selectionStatus, sourceLabel,
    type SkillBody, type SkillListing, type SkillSelection,
} from "./types";

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
    listing, selected, preview, loading, busy = false, error = null, onInspect, onSelect, onDeselect,
}: SkillsPanelProps) {
    const blocked = loading || busy || Boolean(error);
    const entries = listing?.entries ?? [];
    const previewEntry = preview && entries.find((entry) => sameSelection(entry, preview.selection));
    const orphaned = selected.filter((selection) =>
        !entries.some((entry) => entry.id === selection.id && sameSource(entry.source, selection.source)));
    return <section className="stack" aria-label="스킬 탐색과 선택" aria-busy={loading || busy}>
        <h3>스킬</h3>
        <p className="muted small">
            사용자 선택만 다음 모델 호출의 지침에 적용합니다. 자동 매칭 없음. 도구 실행 권한은 부여하지 않습니다.
            전역 출처는 서버 데이터 디렉터리의 skills/, 프로젝트 출처는 현재 실행 root의 .agents/skills/입니다.
            프로젝트 출처가 전역보다 우선하며 같은 단계의 동명 항목은 충돌로 표시합니다.
            명시적 선택은 우선순위가 낮은 항목도 지정할 수 있습니다.
        </p>
        <p className="muted small">
            이름은 디렉터리명입니다. metadata의 이름·alias·도구 요구는 해석하지 않습니다.
            alias는 같은 root 안의 동일 파일 경로로 향하는 symlink만 표시합니다.
            다른 root 간 alias와 hardlink는 판별하지 않습니다.
        </p>
        {loading && <p role="status">스킬 목록·본문을 읽는 중…</p>}
        {error && <p className="err" role="alert">{error}</p>}
        {!loading && !error && listing && entries.length === 0 && <p>허용된 출처에서 조회 가능한 스킬이 없습니다.</p>}
        {!loading && !error && !listing && <p className="muted">스킬 목록이 아직 연결되지 않았습니다.</p>}
        {listing && <ul className="session-list" aria-label="스킬 목록">
            {entries.map((entry) => {
                const status = selectionStatus(entry, selected);
                const prior = selected.find((selection) => selection.id === entry.id && sameSource(selection.source, entry.source));
                return <li key={entry.id} className="stack">
                    <strong>{entry.name}</strong>
                    <span className="muted small">{sourceLabel(entry.source)}</span>
                    <span className="small">{priorityLabel[entry.priority]}</span>
                    {entry.conflicts.length > 0 && <span className="small">동명 후보 {entry.conflicts.length}개 · 아래 목록의 출처로 구분하세요.</span>}
                    {entry.symlink && <span className="muted small">허용된 root 내부 symlink</span>}
                    {entry.alias_of && <span className="muted small">
                        alias · {entries.find((candidate) => candidate.id === entry.alias_of)?.name ?? entry.alias_of}
                    </span>}
                    {entry.metadata === "opaque_front_matter" && <span className="warn small">front matter는 원문으로만 표시합니다.</span>}
                    <span className="muted small">revision <code>{entry.revision}</code></span>
                    <span role="status">{status === "selected" ? "선택됨 · 다음 모델 호출 직전 재검증" : status === "stale" ? "선택한 revision과 다름 · 다시 확인 필요" : "미선택"}</span>
                    <div className="inline">
                        <button type="button" className="ghost small" disabled={blocked} onClick={() => onInspect(bindingOf(entry))}
                            aria-label={`${entry.name} · ${sourceLabel(entry.source)} 본문 보기`}>본문 보기</button>
                        {prior && <button type="button" className="ghost small" disabled={busy}
                            onClick={() => onDeselect({ ...prior, source: { ...prior.source } })}>선택 해제</button>}
                    </div>
                </li>;
            })}
        </ul>}
        {!loading && listing && listing.issues.length > 0 && <div role="status" className="warn small">
            <p>일부 항목을 읽지 못했습니다. 목록은 조회 가능한 항목만 표시합니다.</p>
            <ul>{listing.issues.map((issue, index) => <li key={index}>
                {sourceLabel(issue.source)}{issue.name && ` · ${issue.name}`} · <code>{issue.code}</code>
            </li>)}</ul>
        </div>}
        {orphaned.length > 0 && <div className="warn small">
            <p>현재 목록에서 확인되지 않는 선택이 있습니다. 자동으로 다른 스킬로 바꾸지 않습니다.</p>
            <ul>{orphaned.map((selection) => <li key={`${selection.id}:${selection.revision}`}>
                {sourceLabel(selection.source)} · <code>{selection.id}</code> · revision <code>{selection.revision}</code>
                <button type="button" className="ghost small" disabled={busy}
                    onClick={() => onDeselect({ ...selection, source: { ...selection.source } })}>이 선택 해제</button>
            </li>)}</ul>
        </div>}
        {preview && !loading && !error && !previewEntry && <p className="warn" role="status">
            본문의 출처 또는 revision이 현재 목록과 다릅니다. 목록에서 다시 조회하세요.
        </p>}
        {preview && previewEntry && !loading && !error && <div className="stack" aria-label="스킬 본문">
            <h4>{previewEntry.name} · 읽기 전용 본문</h4>
            <p className="muted small">{sourceLabel(previewEntry.source)} · revision <code>{preview.selection.revision}</code></p>
            <p className="warn small">본문 보기만으로 적용하지 않습니다. 선택하면 다음 모델 호출 직전 출처·revision을 검증해 지침에 넣습니다. 명령은 실행하지 않습니다.</p>
            <pre className="text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflow: "auto" }}>{preview.text}</pre>
            <button type="button" disabled={blocked || selectionStatus(previewEntry, selected) !== "none"
                || selected.some((selection) => !entries.some((entry) => sameSelection(entry, selection)))
                || selected.some((selection) => {
                    const other = entries.find((entry) => sameSelection(entry, selection));
                    return other && (other.name === previewEntry.name
                        || (other.alias_of ?? other.id) === (previewEntry.alias_of ?? previewEntry.id));
                })}
                onClick={() => onSelect(bindingOf(previewEntry))}>이 revision 선택 · 다음 모델 호출에 적용</button>
            <p className="muted small">동명 항목·alias를 바꾸거나 기존 선택이 변경·삭제됐다면 먼저 해제하세요. 선택 시 서버가 본문 revision을 다시 확인해야 합니다.</p>
        </div>}
    </section>;
}
