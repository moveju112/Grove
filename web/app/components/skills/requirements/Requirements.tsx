import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Select } from "../../../design/Select";
import type { SkillCapabilityContext, SkillRequirements } from "../../../api/skills";
import { HelpTip, SentenceText } from "../../HelpTip";

export function Requirements({ report }: { report?: SkillRequirements }) {
    if (!report || (!report.declaration && report.status === "satisfied" && report.problems.length === 0)) return null;
    const declaration = report.declaration;
    return <GroveText as="div" display="block" type="supporting" color="inherit" aria-label="스킬 요구사항">
        <GroveText type="inherit" color="inherit">{report.status === "blocked" ? "요구사항 불충족 · 적용 불가"
                : report.status === "unknown" ? "요구사항 미확정 · 실제 호출 전에 확인 필요" : "관측한 조건에서 요구사항 충족"}</GroveText>
        {declaration && <HelpTip label="요구사항 상세">
            <GroveText type="inherit" color="inherit">요구 도구: {declaration.tools.join(", ") || "없음"}</GroveText>
            <GroveText type="inherit" color="inherit">서버 플랫폼: {declaration.platforms.join(", ") || "제한 없음"}</GroveText>
            <GroveText type="inherit" color="inherit">명시적 의존 스킬: {declaration.skills.join(", ") || "없음"}</GroveText>
            <GroveText type="inherit" color="secondary">도구 실행은 기존 정책·승인을 따릅니다.</GroveText>
        </HelpTip>}
        {report.problems.length > 0 && <GroveList density="compact" edge="flush" listStyle="disc">{report.problems.map((problem, index) =>
            <GroveListItem key={index} label={<>{problem.message} (<code>{problem.code}</code>)</>} />)}</GroveList>}
    </GroveText>;
}

export function RequirementContext({ value, profiles, disabled, onChange }: {
    value: SkillCapabilityContext;
    profiles: readonly { id: string; name: string; enabled: boolean }[];
    disabled: boolean;
    onChange: (value: SkillCapabilityContext) => void;
}) {
    return <fieldset disabled={disabled}>
        <legend>요구사항 검증 조건 <HelpTip label="검증 조건 도움말">
            <SentenceText text="조회 전용이며 입력창의 모델·도구 설정은 바꾸지 않습니다. 호출 직전 실제 요청의 모델·도구 설정과 현재 정책으로 다시 검증합니다." />
        </HelpTip></legend>
        <Select label="검증할 모델" disabled={disabled} value={value.profile_id ?? ""}
            onChange={(profile_id) => onChange({ ...value, profile_id: profile_id || undefined })}
            options={[{ value: "", label: "미확정" }, ...profiles.filter((profile) => profile.enabled)
                .map((profile) => ({ value: profile.id, label: profile.name }))]} />
        <Select label="검증할 도구 사용" disabled={disabled} value={value.tools_enabled === undefined ? "" : String(value.tools_enabled)}
            onChange={(tools) => onChange({ ...value, tools_enabled: tools === "" ? undefined : tools === "true" })}
            options={[{ value: "", label: "미확정" }, { value: "true", label: "사용" }, { value: "false", label: "사용 안 함" }]} />
    </fieldset>;
}
