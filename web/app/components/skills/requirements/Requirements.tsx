import type { SkillCapabilityContext, SkillRequirements } from "../../../api/skills";

export function Requirements({ report }: { report?: SkillRequirements }) {
    if (!report) return null;
    const declaration = report.declaration;
    return <div className="stack small" aria-label="스킬 요구사항">
        <span>{!declaration && report.status === "satisfied" ? "요구 선언 없음 · 기존 동작 유지"
            : report.status === "blocked" ? "요구사항 불충족 · 적용 불가"
                : report.status === "unknown" ? "요구사항 미확정 · 실제 호출 전에 확인 필요" : "관측한 조건에서 요구사항 충족"}</span>
        {declaration && <>
            <span>요구 도구: {declaration.tools.join(", ") || "없음"}</span>
            <span>서버 플랫폼: {declaration.platforms.join(", ") || "제한 없음"}</span>
            <span>명시적 의존 스킬: {declaration.skills.join(", ") || "없음"}</span>
        </>}
        {report.problems.length > 0 && <ul>{report.problems.map((problem, index) =>
            <li key={index}>{problem.message} (<code>{problem.code}</code>)</li>)}</ul>}
        {declaration && <span className="muted">등록·schema 조회는 실행 허가가 아닙니다. 실행 시 기존 정책·승인을 다시 검사합니다.</span>}
    </div>;
}

export function RequirementContext({ value, profiles, disabled, onChange }: {
    value: SkillCapabilityContext;
    profiles: readonly { id: string; name: string; enabled: boolean }[];
    disabled: boolean;
    onChange: (value: SkillCapabilityContext) => void;
}) {
    return <fieldset disabled={disabled} className="stack">
        <legend>요구사항 검증 조건</legend>
        <p className="muted small">아래는 조회용 조건입니다. 입력창의 모델·도구 설정은 변경하지 않습니다.
            실제 접수된 모델·도구 설정과 현재 정책으로 호출 직전에 다시 검증합니다.</p>
        <label>검증할 모델
            <select value={value.profile_id ?? ""} onChange={(event) => onChange({ ...value, profile_id: event.target.value || undefined })}>
                <option value="">미확정</option>
                {profiles.filter((profile) => profile.enabled).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
        </label>
        <label>검증할 도구 사용
            <select value={value.tools_enabled === undefined ? "" : String(value.tools_enabled)}
                onChange={(event) => onChange({ ...value, tools_enabled: event.target.value === "" ? undefined : event.target.value === "true" })}>
                <option value="">미확정</option><option value="true">사용</option><option value="false">사용 안 함</option>
            </select>
        </label>
    </fieldset>;
}
