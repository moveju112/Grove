import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useLayoutEffect, useRef, useState } from "react";
import { BooleanSelect } from "./BooleanSelect";
import { HelpTip, SentenceText } from "./HelpTip";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";
import type { ModelProfile } from "../api/generated";
import { APPLIES, SCOPE_LABEL } from "./settings/constants";
import { useAutosave } from "./settings/useAutosave";
import { AutosaveStatus } from "./settings/AutosaveStatus";
import type { SettingLinkReady } from "./settings-links/reveal";
import { SettingsGroup } from "./SettingsGroup";
import { TextInput, TextArea, DraftInput } from "../design/Fields";
import { Select } from "../design/Select";

export type SettingDef = {
    key: string;
    menu: string;
    label: string;
    description: string;
    keywords: string;
    kind: "bool" | "int" | "string" | "text" | "enum" | "tool_list";
    options: string[];
    min: number | null;
    max: number | null;
    default: unknown;
    scopes: string[];
    applies: "immediate" | "next_turn" | "restart";
    advanced: boolean;
};
type Layer = { scope_id: string; value: unknown; revision: number };
type Item = { key: string; default: unknown; layers: Record<string, Layer>; effective: unknown; source: string };

const ENUM_LABEL: Record<string, Record<string, string>> = {
    "output.style": { default: "모델 기본", concise: "간결하게", detailed: "자세하게" },
};
const PROFILE_KEYS = new Set(["model.default_profile", "context.summary_profile"]);

function ProfileChoice({ d, value, disabled, edit }: { d: SettingDef; value: unknown; disabled: boolean; edit: (value: string) => void }) {
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const id = String(value ?? "");
    const selected = profiles.data?.find((profile) => profile.id === id);
    return <GroveStack gap={1} width={220} maxWidth="100%">
        <Select label={d.label} hideLabel value={id} disabled={disabled || !profiles.data} onChange={edit}
            options={[{ value: "", label: d.key === "context.summary_profile" ? "요청에 쓰는 모델 사용" : "기기 선택 또는 첫 활성 모델" },
                ...(id && profiles.data && !selected ? [{ value: id, label: "사용 불가 모델(삭제됐거나 접근 불가)", disabled: true }] : []),
                ...(profiles.data ?? []).map((profile) => ({ value: profile.id, disabled: profile.enabled === false,
                    label: `${profile.name} · ${profile.protocol} · ${profile.model}${profile.enabled === false ? " · 비활성" : ""}` }))]} />
        {selected && <GroveText type="supporting" color="secondary"> 전송 대상: {selected.base_url || "서버 설치 CLI"} · {selected.model}</GroveText>}
        {id && profiles.data && (!selected || selected.enabled === false) && <GroveText as="p" display="block" type="supporting" color="warning" role="status">현재 모델을 사용할 수 없습니다. 다른 모델로 자동 전환하지 않습니다.</GroveText>}
        {Boolean(profiles.error) && <GroveText as="p" display="block" type="inherit" color="error" role="alert">모델 목록을 읽지 못했습니다. <GroveButton variant="secondary" density="compact" onClick={profiles.reload}>다시 읽기</GroveButton></GroveText>}
    </GroveStack>;
}

/// 연 위치(프로젝트·대화)를 정확히 가리키는 대상 정보. 탭을 열 때 고정되어 pane 전환으로 바뀌지 않는다(CONFIG-005, SETTINGS-024).
export type SettingsTarget = { projectId?: string; projectName?: string; sessionId?: string; sessionTitle?: string };

/// 범위별 설정 편집기.
const SETTING_GROUPS: Record<string, string> = {
    model: "기본 모델", output: "대화·응답", user: "대화·응답",
    session: "대화·응답", sessions: "대화·응답", context: "컨텍스트",
    agents: "에이전트 실행", tools: "도구·권한", runs: "실행 한도",
    storage: "보관·정리", approval: "승인",
};

function initialScope(d: SettingDef, target: SettingsTarget) {
    return target.sessionId && d.scopes.includes("session") ? "session"
        : target.projectId && d.scopes.includes("project") ? "project" : "server";
}

export function ScopedSettings({ defs, target, linkedKey, onLinkReady, grouped = false }: {
    defs: SettingDef[]; target: SettingsTarget;
    linkedKey?: string; onLinkReady?: SettingLinkReady; grouped?: boolean;
}) {
    const p = new URLSearchParams();
    if (target.sessionId) p.set("session_id", target.sessionId);
    else if (target.projectId) p.set("project_id", target.projectId);
    const eff = useQuery<{ items: Item[] }>(`settings:${target.sessionId ?? target.projectId ?? "-"}`, () => api.get(`/settings/effective?${p}`));
    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (!linkedKey || !onLinkReady || !defs.some((definition) => definition.key === linkedKey)) return;
        if (eff.error) return onLinkReady(linkedKey, null);
        if (!eff.data || eff.loading) return;
        // 이 편집기에 속한 실제 행만 조회한다. 키는 CSS selector에 삽입하지 않는다.
        const row = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-setting-key]") ?? [])
            .find((element) => element.dataset.settingKey === linkedKey) ?? null;
        onLinkReady(linkedKey, row);
    }, [linkedKey, onLinkReady, defs, eff.data, eff.error, eff.loading]);
    const groups = new Map<string, SettingDef[]>();
    for (const definition of defs) {
        const title = SETTING_GROUPS[definition.key.split(".")[0]!] ?? "기본 설정";
        const group = groups.get(title);
        if (group) group.push(definition);
        else groups.set(title, [definition]);
    }
    const renderRow = (d: SettingDef) => {
        const it = eff.data?.items.find((i) => i.key === d.key);
        return it ? <Row key={`${d.key}:${target.sessionId ?? target.projectId ?? "-"}`} d={d} it={it} t={target} reload={eff.reload} /> : null;
    };
    return (
        <Grid gap={grouped ? 4 : 0} ref={root}>
            {grouped ? Array.from(groups, ([title, definitions]) => <SettingsGroup key={title} title={title}
                scope={[...new Set(definitions.map((definition) => scopeTarget(initialScope(definition, target), target)[1]))].join(" · ")}>
                {definitions.map(renderRow)}
            </SettingsGroup>) : defs.map(renderRow)}
        </Grid>
    );
}

/// 범위 → (저장 경로의 scope_id, 화면 대상명)
function scopeTarget(scope: string, t: SettingsTarget): [string, string] {
    if (scope === "session") return [t.sessionId!, `대화 “${t.sessionTitle ?? t.sessionId}”`];
    if (scope === "project") return [t.projectId!, `프로젝트 “${t.projectName ?? t.projectId}”`];
    return ["-", "서버 전체(모든 기기·프로젝트)"];
}

function Row({ d, it, t, reload }: { d: SettingDef; it: Item; t: SettingsTarget; reload: () => void }) {
    const scopes = d.scopes.filter((s) => s === "server" || (s === "project" && t.projectId) || (s === "session" && t.sessionId));
    const [scope, setScope] = useState<string>(initialScope(d, t));
    return <SettingValue key={scope} d={d} it={it} t={t} reload={reload} scope={scope} scopes={scopes} setScope={setScope} />;
}

function SettingValue({ d, it, t, reload, scope, scopes, setScope }: {
    d: SettingDef; it: Item; t: SettingsTarget; reload: () => void; scope: string; scopes: string[]; setScope: (scope: string) => void;
}) {
    const layer = it.layers[scope];
    const normalize = (item: Item) => {
        const value = item.layers[scope]?.value ?? item.effective;
        return d.kind === "int" ? String(value ?? "") : value ?? "";
    };
    const state = useAutosave<unknown>({
        id: `${scope}:${scopeTarget(scope, t)[0]}:${d.key}`, value: normalize(it), revision: layer?.revision ?? 0,
        save: async (value, revision, key) => {
            if (d.kind === "int" && !/^-?\d+$/.test(String(value))) throw new ApiError(422, "invalid_input", "정수를 입력하세요.");
            try {
                const result = await api.put<{ item: Item }>(`/settings/${scope}/${scopeTarget(scope, t)[0]}/${d.key}`,
                    { expected_revision: revision, value: d.kind === "int" ? Number(value) : value }, { key });
                return { value: normalize(result.item), revision: result.item.layers[scope]!.revision };
            } finally { reload(); }
        },
    });
    const value = state.value;
    const edit = state.change;
    const choose = (value: unknown) => { edit(value); state.commit(); };
    const [, target] = scopeTarget(scope, t);
    return (
        <GroveStack as="section" gap={2} padding={3} data-testid={`setting-${d.key}`} data-setting-key={d.key}>
            <GroveStack gap={1.5} direction="horizontal" align="center" wrap="wrap">
            <GroveHeading level={2} color="inherit">
                {d.label} {d.advanced && <GroveText type="supporting" color="secondary">고급</GroveText>}{" "}
                <Link type="supporting" color="secondary" href={`#setting-${encodeURIComponent(d.key)}`} tooltip="이 항목으로 바로 가는 링크" aria-label={`${d.label} 링크`}>#</Link>
            </GroveHeading>
            <HelpTip label={`${d.label} 도움말`}>
                <SentenceText text={d.description} />
                <GroveText type="inherit" color="inherit">실제 적용값: <code>{JSON.stringify(it.effective)}</code> ({SCOPE_LABEL[it.source]}) · 기본값 <code>{JSON.stringify(it.default)}</code></GroveText>
            </HelpTip>
            </GroveStack>
            <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
                {scopes.length > 1 && (
                    <Select disabled={state.phase === "saving" || state.phase === "uncertain"} label={`${d.label} 적용 범위`} hideLabel value={scope}
                        onChange={setScope}
                        options={scopes.map((value) => ({ value, label: SCOPE_LABEL[value] }))} />
                )}
                <GroveText type="supporting" color="secondary" data-settings-target={target}>대상: {target}</GroveText>
                {d.kind === "bool" && (
                    <BooleanSelect label={d.label} hideLabel value={Boolean(value)} onChange={choose} />
                )}
                {d.kind === "enum" && (
                    <Select label={d.label} hideLabel value={String(value ?? "")} onChange={choose}
                        options={d.options.map((value) => ({ value, label: ENUM_LABEL[d.key]?.[value] ?? value }))} />
                )}
                {d.kind === "int" && (
                    <DraftInput type="number" label={d.label} isLabelHidden min={d.min ?? undefined} max={d.max ?? undefined} value={String(value)} onChange={edit} onBlur={state.blur} />
                )}
                {PROFILE_KEYS.has(d.key) && <ProfileChoice d={d} value={value} disabled={false} edit={choose} />}
                {((d.kind === "string" && !PROFILE_KEYS.has(d.key)) || d.kind === "tool_list") && (
                    <TextInput
                        label={d.label} isLabelHidden
                        placeholder={d.kind === "tool_list" ? "예: shell, write_file" : undefined}
                        value={String(value ?? "")}
                        onChange={edit}
                        onBlur={state.blur}
                    />
                )}
                {d.kind === "text" && <TextArea label={d.label} isLabelHidden rows={4} value={String(value ?? "")} onChange={edit} onBlur={state.blur} />}
            </GroveStack>
            {d.key === "tools.full_access" && (Boolean(value) || Boolean(it.effective)) && (
                <GroveText as="p" display="block" type="supporting" color="warning">
                    셸이 프로젝트 밖 파일·네트워크·서버 계정의 자격증명에 접근할 수 있어요. 임의 명령을 허용하므로 신뢰하는 작업에만 켜세요.
                </GroveText>
            )}
            <AutosaveStatus state={state} applies={APPLIES[d.applies]} />
        </GroveStack>
    );
}
