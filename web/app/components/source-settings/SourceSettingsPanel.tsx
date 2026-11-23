import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Code } from "@astryxdesign/core/Code";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import type { ReadErrorCode, SafeSettings, SourceId, SourceSettings, SourceSettingsPanelProps } from "./types";
import type { SourceResource } from "../../api/sourceSettings";
import { DetailDialog } from "../ui/Controls";
import { HelpTip } from "../HelpTip";

const SOURCE: Record<SourceId, { label: string; location: string }> = {
    claude_user: { label: "Claude · 사용자 원본", location: "Claude / settings.json" },
    claude_project: { label: "Claude · 프로젝트 원본", location: ".claude/settings.json" },
    claude_project_local: { label: "Claude · 프로젝트 로컬 원본", location: ".claude/settings.local.json" },
    codex_user: { label: "Codex · 사용자 원본", location: "Codex / config.toml" },
    codex_project: { label: "Codex · 프로젝트 원본", location: ".codex/config.toml" },
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
        return <GroveText as="p" display="block" type="supporting" color="secondary">표시 가능한 필드 없음</GroveText>;
    }
    return <dl>
        {booleans.map(([key, label]) => <GroveStack gap={0} key={key}>
            <dt>{label}</dt>
            <dd>{value[key] ? "켜짐" : "꺼짐"}</dd>
        </GroveStack>)}
        {hasDays && <GroveStack gap={0}>
            <dt>대화 보관 기간</dt>
            <dd>{days}일</dd>
        </GroveStack>}
    </dl>;
}

function ResourceCard({ resource }: { resource: SourceResource }) {
    const result = resource.result;
    const label = resource.kind === "skills" ? "스킬" : "자동 실행";
    if (result.status === "missing" || (result.status === "present" && result.entries.length === 0 && !result.ignored_invalid_entries)) return null;
    return <GroveStack as="section" gap={2} paddingBlockStart={4} aria-label={`${label} · ${resource.relative_path}`}>
        <Divider />
        <GroveHeading level={4} color="inherit"><GroveStack as="span" direction="horizontal" align="center" gap={2}>{label}
            <HelpTip label={`${label} 경로`}><Code color="secondary">{resource.relative_path}</Code></HelpTip>
        </GroveStack></GroveHeading>
        {result.status === "read_error" && <GroveText as="p" display="block" type="inherit" color="error" role="alert">리소스 읽기 실패: {result.code === "too_large" ? "리소스 크기 또는 항목 수가 조회 제한을 넘어 표시하지 않았습니다." : ERROR[result.code]}</GroveText>}
        {result.status === "unsupported_format" && <GroveText as="p" display="block" type="supporting" color="warning">Inline hook · 미지원 형식(TOML)</GroveText>}
        {result.status === "present" && <>
            {resource.kind === "skills" && resource.result.status === "present" && <GroveStack gap={2}>
                {resource.result.entries.map((entry, index) => <DetailDialog key={index} label={`${entry.name} 스킬`} title={entry.name}>
                    {entry.description && <GroveText as="p" display="block" type="inherit" color="inherit">{entry.description}</GroveText>}
                    <Code color="secondary">{entry.relative_path}</Code>
                </DetailDialog>)}
            </GroveStack>}
            {resource.kind === "hooks" && resource.result.status === "present" && resource.result.entries.length > 0 &&
                <DetailDialog label="자동 실행 상세" title={`자동 실행 ${resource.result.entries.length}개`}>
                    <dl>
                        {resource.result.entries.map((entry, index) => <GroveStack gap={0} key={index}>
                            <dt>{entry.event}</dt>
                            <dd>Matcher: {entry.matcher ?? "지정 없음"} · 명령 {entry.has_command ? "있음" : "없음"}</dd>
                        </GroveStack>)}
                    </dl>
                </DetailDialog>}
            {result.ignored_invalid_entries && <GroveText as="p" display="block" type="supporting" color="warning" role="status">일부 항목은 형식·권한·읽기 제한으로 생략됐습니다.</GroveText>}
        </>}
    </GroveStack>;
}

function SourceCard({ item, resources }: { item: SourceSettings; resources: readonly SourceResource[] }) {
    const source = SOURCE[item.source];
    return <Card padding={3} role="region" aria-label={source.label}><GroveStack gap={2}>
        <GroveHeading level={3} color="inherit"><GroveStack as="span" direction="horizontal" align="center" gap={2}>{source.label}
            <HelpTip label={`${source.label} 경로`}><Code color="secondary">{source.location}</Code></HelpTip>
        </GroveStack></GroveHeading>
        {item.status === "present" && <>
            <Projection value={item.projection} />
            {item.ignored_invalid_fields && <GroveText as="p" display="block" type="supporting" color="warning">타입이나 범위가 맞지 않는 값은 생략했습니다.</GroveText>}
        </>}
        {item.status === "missing" && <GroveText as="p" display="block" type="supporting" color="secondary">원본 파일 없음</GroveText>}
        {item.status === "read_error" && <GroveText as="p" display="block" type="inherit" color="error" role="alert">읽기 실패: {ERROR[item.code]}</GroveText>}
        {item.status === "unsupported_format" && <GroveText as="p" display="block" type="supporting" color="warning">미지원 형식(TOML)</GroveText>}
        {resources.map((resource) => <ResourceCard key={`${resource.kind}:${resource.relative_path}`} resource={resource} />)}
    </GroveStack></Card>;
}

/** 인증된 서버 projection만 주입한다. 이 UI는 조회 API·쓰기·적용 동작을 호출하지 않는다. */
export function SourceSettingsPanel({ view }: SourceSettingsPanelProps) {
    return <GroveStack gap={3}>
        <GroveText as="p" display="block" type="supporting" color="secondary">읽기 전용 · Grove 적용값 아님</GroveText>
        {view.status === "loading" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">원본 출처를 확인하는 중입니다.</GroveText>}
        {view.status === "error" && <GroveText as="p" display="block" type="inherit" color="error" role="alert">원본 출처 목록을 가져오지 못했습니다.</GroveText>}
        {view.status === "ready" && (view.items.length === 0
            ? <GroveText as="p" display="block" type="supporting" color="secondary">조회 대상 없음</GroveText>
            : view.items.map((item) => <SourceCard key={item.source} item={item} resources={(view.resources ?? []).filter((resource) => resource.source === item.source)} />))}
    </GroveStack>;
}
