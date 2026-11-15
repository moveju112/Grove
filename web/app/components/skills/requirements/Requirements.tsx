import { Text as GroveText } from "@astryxdesign/core/Text";
import type { SkillCapabilityContext, SkillRequirements } from "../../../api/skills";
import { HelpTip, SentenceText } from "../../HelpTip";

export function Requirements({ report }: { report?: SkillRequirements }) {
    if (!report) return null;
    const declaration = report.declaration;
    return <div className="stack small" aria-label="스킬 요구사항">
        <GroveText type="inherit" color="inherit">{!declaration && report.status === "satisfied" ? "요구 선언 없음 · 기존 동작 유지"
            : report.status === "blocked" ? "요구사항 불충족 · 적용 불가"
                : report.status === "unknown" ? "요구사항 미확정 · 실제 호출 전에 확인 필요" : "관측한 조건에서 요구사항 충족"}</GroveText>
        {declaration && <>
            <GroveText type="inherit" color="inherit">요구 도구: {declaration.tools.join(", ") || "없음"}</GroveText>
            <GroveText type="inherit" color="inherit">서버 플랫폼: {declaration.platforms.join(", ") || "제한 없음"}</GroveText>
            <GroveText type="inherit" color="inherit">명시적 의존 스킬: {declaration.skills.join(", ") || "없음"}</GroveText>
        </>}
        {report.problems.length > 0 && <ul>{report.problems.map((problem, index) =>
            <li key={index}>{problem.message} (<code>{problem.code}</code>)</li>)}</ul>}
        {declaration && <GroveText type="inherit" color="secondary">도구 실행은 기존 정책·승인을 따릅니다.</GroveText>}
    </div>;
}

export function RequirementContext({ value, profiles, disabled, onChange }: {
    value: SkillCapabilityContext;
    profiles: readonly { id: string; name: string; enabled: boolean }[];
    disabled: boolean;
    onChange: (value: SkillCapabilityContext) => void;
}) {
    return <fieldset disabled={disabled} className="stack">
        <legend>요구사항 검증 조건 <HelpTip label="검증 조건 도움말">
            <SentenceText text="조회 전용이며 입력창의 모델·도구 설정은 바꾸지 않습니다. 호출 직전 실제 요청의 모델·도구 설정과 현재 정책으로 다시 검증합니다." />
        </HelpTip></legend>
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
