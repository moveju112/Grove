import type { ReadErrorCode, SafeSettings, SourceId, SourceSettings, SourceSettingsPanelProps } from "./types";
import type { SourceResource } from "../../api/sourceSettings";

const SOURCE: Record<SourceId, { label: string; location: string }> = {
    claude_user: { label: "Claude · 사용자 원본", location: "서버에서 결정한 Claude 설정 디렉터리 / settings.json" },
    claude_project: { label: "Claude · 프로젝트 원본", location: "선택한 프로젝트 / .claude/settings.json" },
    claude_project_local: { label: "Claude · 프로젝트 로컬 원본", location: "서버에서 결정한 로컬 설정 대상 프로젝트 / .claude/settings.local.json" },
    codex_user: { label: "Codex · 사용자 원본", location: "서버에서 결정한 Codex 설정 디렉터리 / config.toml" },
    codex_project: { label: "Codex · 프로젝트 원본", location: "선택한 프로젝트 / .codex/config.toml" },
};

const ERROR: Record<ReadErrorCode, string> = {
    permission_denied: "원본을 읽을 권한이 없거나 허용된 출처 경계 밖을 가리켜 읽지 않았습니다.",
    not_regular_file: "일반 파일이 아니라 읽지 않았습니다.",
    too_large: "원본이 읽기 제한(256 KiB)을 넘어 표시하지 않았습니다.",
    invalid_json: "올바른 JSON이 아니어서 표시하지 않았습니다.",
    invalid_shape: "JSON 객체 형식이 아니어서 표시하지 않았습니다.",
    io: "원본을 읽지 못했습니다.",
};

const BOOLEAN_FIELDS = [
    ["alwaysThinkingEnabled", "확장 사고"],
    ["autoCompactEnabled", "자동 압축"],
    ["autoMemoryEnabled", "자동 메모리"],
] as const;

function Projection({ value }: { value: SafeSettings }) {
    const booleans = BOOLEAN_FIELDS.filter(([key]) => typeof value[key] === "boolean");
    const days = value.cleanupPeriodDays;
    const hasDays = typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 4_294_967_295;
    if (booleans.length === 0 && !hasDays) {
        return <p className="muted small">표시 가능한 안전 필드가 없습니다. 원본이 비어 있거나 Grove 기본값이 적용됐다는 뜻은 아닙니다.</p>;
    }
    return <dl>
        {booleans.map(([key, label]) => <div key={key}>
            <dt>{label} <code>{key}</code></dt>
            <dd>{value[key] ? "켜짐" : "꺼짐"}</dd>
        </div>)}
        {hasDays && <div>
            <dt>원본 대화 보관 기간 <code>cleanupPeriodDays</code></dt>
            <dd>{days}일</dd>
        </div>}
    </dl>;
}

function ResourceCard({ resource }: { resource: SourceResource }) {
    const result = resource.result;
    const label = resource.kind === "skills" ? "스킬" : "Hook 정의";
    const root = resource.source === "codex_user" && resource.relative_path === ".agents/skills"
        ? "서버 사용자 홈"
        : resource.source.endsWith("_user") ? "서버 CLI 설정 디렉터리" : "선택한 프로젝트";
    return <section aria-label={`${label} · ${resource.relative_path}`}>
        <h4>{label} · <code>{resource.relative_path}</code></h4>
        <p className="muted small">리소스 출처: {root} / {resource.relative_path}</p>
        {result.status === "missing" && <p className="muted small">원본 리소스가 없습니다. 생성하거나 가져오지 않습니다.</p>}
        {result.status === "read_error" && <p className="err" role="alert">리소스 읽기 실패: {result.code === "too_large" ? "리소스 크기 또는 항목 수가 조회 제한을 넘어 표시하지 않았습니다." : ERROR[result.code]}</p>}
        {result.status === "unsupported_format" && <p className="warn small">Inline hook · 미지원 형식(TOML). hook의 부재나 Grove 적용 여부를 뜻하지 않습니다.</p>}
        {result.status === "present" && <>
            {result.entries.length === 0 && <p className="muted small">표시 가능한 {label} 항목이 없습니다.</p>}
            {resource.kind === "skills" && resource.result.status === "present" && <dl>
                {resource.result.entries.map((entry, index) => <div key={index}>
                    <dt>{entry.name}</dt>
                    <dd>{entry.description ?? "설명을 표시할 수 없습니다."} · <code>{entry.relative_path}</code></dd>
                </div>)}
            </dl>}
            {resource.kind === "hooks" && resource.result.status === "present" && <dl>
                {resource.result.entries.map((entry, index) => <div key={index}>
                    <dt>{entry.event}</dt>
                    <dd>Matcher: {entry.matcher ?? "지정 없음"} · 명령 {entry.has_command ? "있음" : "없음"} · 명령 원문 비공개</dd>
                </div>)}
            </dl>}
            {result.ignored_invalid_entries && <p className="warn small" role="status">일부 항목은 형식·권한·symlink·읽기 제한 때문에 생략했습니다. 스킬은 바로 아래 폴더의 SKILL.md와 제한된 frontmatter만 지원합니다.</p>}
        </>}
    </section>;
}

function SourceCard({ item, resources }: { item: SourceSettings; resources: readonly SourceResource[] }) {
    const source = SOURCE[item.source];
    return <section className="setting" aria-label={source.label}>
        <h3>{source.label}</h3>
        <p className="muted small">출처: {source.location}</p>
        <p className="scope">원본 조회 전용 · Grove 실제 적용 상태와 별개</p>
        {item.status === "present" && <>
            <p>존재함 · 허용된 필드만 표시</p>
            <Projection value={item.projection} />
            {item.ignored_invalid_fields && <p className="warn small">지원 필드 중 타입이나 범위가 맞지 않는 값은 생략했습니다. 원본 값은 표시하지 않습니다.</p>}
        </>}
        {item.status === "missing" && <p className="muted small">원본 파일 또는 출처 디렉터리가 없습니다. 설정을 생성하거나 기본값을 추측하지 않습니다.</p>}
        {item.status === "read_error" && <p className="err" role="alert">읽기 실패: {ERROR[item.code]}</p>}
        {item.status === "unsupported_format" && <p className="warn small">존재함 · 미지원 형식(TOML). 전용 parser가 없어 내용을 읽거나 설정을 추측하지 않습니다.</p>}
        {resources.map((resource) => <ResourceCard key={`${resource.kind}:${resource.relative_path}`} resource={resource} />)}
    </section>;
}

/** 인증된 서버 projection만 주입한다. 이 UI는 조회 API·쓰기·적용 동작을 호출하지 않는다. */
export function SourceSettingsPanel({ view }: SourceSettingsPanelProps) {
    return <section aria-label="원본 Claude/Codex 설정">
        <h2>원본 Claude/Codex 설정 · 읽기 전용</h2>
        <p>이 화면은 서버에 있는 원본 파일의 일부만 보여 줍니다. 원본을 조회했다고 Grove에 적용된 것은 아닙니다.</p>
        <p className="muted small">Grove 실제 적용 설정은 Grove의 범위별 설정 화면에서 확인하세요. 원본 간 우선순위나 Claude/Codex의 최종 유효값도 계산하지 않습니다.</p>
        <p className="muted small">원문·환경 변수·토큰·자격증명·명령·스킬 본문은 표시하지 않습니다. 지원하지 않는 필드도 생략하며 수정·적용·가져오기·훅 실행은 제공하지 않습니다.</p>
        {view.status === "loading" && <p role="status">원본 출처를 확인하는 중입니다.</p>}
        {view.status === "error" && <p className="err" role="alert">원본 출처 목록을 가져오지 못했습니다. Grove 설정의 적용 여부와는 관계없습니다.</p>}
        {view.status === "ready" && (view.items.length === 0
            ? <p className="muted small">조회 대상으로 전달된 원본 출처가 없습니다. 원본 파일이 없다는 뜻은 아닙니다.</p>
            : view.items.map((item) => <SourceCard key={item.source} item={item} resources={(view.resources ?? []).filter((resource) => resource.source === item.source)} />))}
    </section>;
}
