import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import { ProfileModels, useModelCatalog } from "./ModelSelect";
import { catalogModel, modelEfforts } from "./model-catalog";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Button as GroveButton } from "../design/Button";
import { useLayoutEffect, useRef, useState } from "react";
import { BooleanSelect } from "./BooleanSelect";
import { Icon } from "./icons";
import { HelpTip, SentenceText } from "./HelpTip";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";
import type { ModelProfile, ModelSelection } from "../api/generated";
import { APPLIES, SCOPE_LABEL } from "./settings/constants";
import { useAutosave } from "./settings/useAutosave";
import { AutosaveStatus } from "./settings/AutosaveStatus";
import type { SettingLinkReady } from "./settings-links/reveal";
import { SettingsGroup } from "./SettingsGroup";
import { TextInput, DraftInput } from "../design/Fields";
import { Select } from "../design/Select";
import { workflowStyles } from "./settings/workflow.stylex";

export type SettingDef = {
    key: string;
    menu: string;
    label: string;
    description: string;
    keywords: string;
    kind: "bool" | "int" | "string" | "enum" | "tool_list" | "model";
    options: string[];
    min: number | null;
    max: number | null;
    default: unknown;
    scopes: string[];
    applies: "immediate" | "next_turn" | "restart";
    advanced: boolean;
};
type Layer = { scope_id: string; value: unknown; revision: number };
export type SettingItem = { key: string; default: unknown; layers: Record<string, Layer>; effective: unknown; source: string };
type Item = SettingItem;

const ENUM_LABEL: Record<string, Record<string, string>> = {
    "output.style": { default: "디폴트", detailed: "디테일", simple: "심플", minimal: "미니멀", "extreme-minimal": "익스트림 미니멀" },
    "exec.shell": { default: "기본 셸" },
    "tools.mode": { ask: "ask · 승인 요청", bypass: "bypass · 승인 생략" },
    "agents.orchestration": { solo: "Solo · 기본 역할만", delegated: "켜짐 · 에이전트 위임" },
};
const PROFILE_KEYS = new Set(["model.default_profile", "context.summary_profile", "session.title_profile", "memory.profile"]);
export const ROLE_DISABLED = "__role_disabled__";
export const isRoleProfile = (key: string) => key !== "model.default_profile" && (PROFILE_KEYS.has(key) || key.startsWith("agents.profile."));

export function profileChoiceValue(value: unknown): string {
    if (!value || typeof value !== "object") return String(value ?? "");
    const selected = value as ModelSelection;
    return selected.model ? JSON.stringify([selected.profile_id, selected.model]) : selected.profile_id;
}

export function ProfileChoice({ d, value, disabled, edit, roleEnabled, onEffortChange, workflow }: {
    d: SettingDef; value: unknown; disabled: boolean; edit: (value: unknown) => void; roleEnabled?: boolean;
    onEffortChange?: (selection: ModelSelection) => void; workflow?: boolean;
}) {
    const profiles = useModelProfiles();
    const selection = value && typeof value === "object" ? value as ModelSelection : undefined;
    const id = selection?.profile_id ?? String(value ?? "");
    const selected = profiles.data?.find((profile) => profile.id === id);
    const requiresModel = d.key === "session.title_profile" || d.key === "memory.profile";
    const fallback = d.key === "context.summary_profile" ? "대화 모델로 압축"
        : d.key.startsWith("agents.profile.") ? "부모 대화 모델 사용" : "기기 선택 또는 첫 활성 모델";
    const effortProfile = (workflow || roleEnabled) && onEffortChange && selected?.enabled && selected.capabilities.effort !== false ? selected : undefined;
    const catalog = useModelCatalog(effortProfile && ["codex_cli", "codex_oauth", "claude_code", "anthropic"].includes(effortProfile.protocol) ? effortProfile : undefined);
    const efforts = modelEfforts(effortProfile, catalogModel(catalog.data?.models, effortProfile, selection?.model));
    const effort = selection?.effort ?? "auto";
    return <GroveStack gap={1} width={workflow ? "100%" : 220} maxWidth="100%">
        <Grid gap={workflow ? 2 : 1} xstyle={workflow ? workflowStyles.fields : undefined} data-testid={workflow ? "workflow-fields" : undefined}>
        <GroveStack gap={1} xstyle={workflow ? workflowStyles.field : undefined}>
        {workflow && <GroveText type="supporting" color="secondary">모델</GroveText>}
        {isRoleProfile(d.key) ? <DropdownMenu renderTrigger={(props) => <GroveButton {...props} type="button" appearance="disclosure"
            aria-label={d.label} disabled={disabled || !profiles.data} width="100%"
            data-selected-value={roleEnabled === false ? ROLE_DISABLED : profileChoiceValue(value)}>
            <GroveStack as="span" width="100%" direction="horizontal" align="center" justify="between" gap={1.5}>
                <GroveText as="span" type="inherit" maxLines={1}>{roleEnabled === false ? "사용 안 함" : selected ? `${selected.name} · ${selection?.model ?? selected.model}` : id ? "사용 불가 모델" : requiresModel ? "모델 선택" : fallback}</GroveText>
                <Icon name="chevronDown" size={16} />
            </GroveStack>
        </GroveButton>}>
            <DropdownMenuRadioGroup label={d.label} value={roleEnabled === false ? ROLE_DISABLED : id ? undefined : ""} onChange={edit}>
                {roleEnabled !== undefined && <DropdownMenuRadioItem value={ROLE_DISABLED} label="사용 안 함" data-option-value={ROLE_DISABLED} />}
                {!requiresModel && <DropdownMenuRadioItem value="" label={fallback} data-option-value="" />}
            </DropdownMenuRadioGroup>
            {(profiles.data ?? []).map((profile) => <ProfileModels key={profile.id} profile={profile}
                profileId={roleEnabled === false ? null : id} model={id === profile.id ? selection?.model : null} includeDefault
                onChange={(profile_id, model) => edit(model ? { profile_id, model } : profile_id)} />)}
        </DropdownMenu> : <Select label={d.label} hideLabel value={roleEnabled === false ? ROLE_DISABLED : id} disabled={disabled || !profiles.data} onChange={edit}
            options={[...(roleEnabled === undefined ? [] : [{ value: ROLE_DISABLED, label: "사용 안 함" }]), { value: "", label: fallback },
                ...(id && profiles.data && !selected ? [{ value: id, label: "사용 불가 모델(삭제됐거나 접근 불가)", disabled: true }] : []),
                ...(profiles.data ?? []).map((profile) => ({ value: profile.id, disabled: profile.enabled === false,
                    label: `${profile.name} · ${profile.protocol} · ${profile.model}${profile.enabled === false ? " · 비활성" : ""}` }))]} />}
        </GroveStack>
        {effortProfile && onEffortChange && (efforts.length > 0 || effort !== "auto") &&
            <GroveStack direction={workflow ? "vertical" : "horizontal"} align={workflow ? "stretch" : "center"} gap={workflow ? 1 : 1.5}
                xstyle={workflow ? workflowStyles.field : undefined}>
                <GroveText type="supporting" color="secondary">추론 강도</GroveText>
                <Select label={`${d.label} 추론 강도`} hideLabel variant={workflow ? undefined : "ghost"} value={effort} disabled={disabled}
                    onChange={(value) => onEffortChange({ profile_id: id, model: selection?.model ?? null, ...(value === "auto" ? {} : { effort: value }) })}
                    options={[{ value: "auto", label: "auto" },
                        ...(effort !== "auto" && !efforts.includes(effort) ? [{ value: effort, label: `${effort} · 미지원`, disabled: true }] : []),
                        ...efforts.map((value) => ({ value, label: value }))]} />
            </GroveStack>}
        </Grid>
        {selected && roleEnabled === undefined && !workflow && <GroveText type="supporting" color="secondary"> 전송 대상: {selected.base_url || "서버 설치 CLI"} · {selected.model}</GroveText>}
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
    agents: "에이전트 실행", memory: "메모리 정리", tools: "도구·권한", runs: "실행 한도",
    storage: "보관·정리", approval: "승인",
};

export function initialScope(d: SettingDef, target: SettingsTarget) {
    return target.sessionId && d.scopes.includes("session") ? "session"
        : target.projectId && d.scopes.includes("project") ? "project" : "server";
}

export function useEffectiveSettings(target: SettingsTarget, enabled = true) {
    const p = new URLSearchParams();
    if (target.sessionId) p.set("session_id", target.sessionId);
    else if (target.projectId) p.set("project_id", target.projectId);
    return useQuery<{ items: Item[] }>(enabled ? `settings:${target.sessionId ?? target.projectId ?? "-"}` : null, () => api.get(`/settings/effective?${p}`));
}

/// 모델 프로필 목록. 설정 화면 진입 시 항목 정의와 함께 미리 시작하고, 모델 선택 행이 같은 key를 공유한다.
export function useModelProfiles(enabled = true) {
    return useQuery<ModelProfile[]>(enabled ? "profiles" : null, () => api.get("/model-profiles"));
}

export function ScopedSettings({ defs, target, linkedKey, onLinkReady, grouped = false }: {
    defs: SettingDef[]; target: SettingsTarget;
    linkedKey?: string; onLinkReady?: SettingLinkReady; grouped?: boolean;
}) {
    const eff = useEffectiveSettings(target);
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
        const title = definition.key.startsWith("agents.profile.") ? "역할별 모델" : SETTING_GROUPS[definition.key.split(".")[0]!] ?? "기본 설정";
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
export function scopeTarget(scope: string, t: SettingsTarget): [string, string] {
    if (scope === "session") return [t.sessionId!, `대화 “${t.sessionTitle ?? t.sessionId}”`];
    if (scope === "project") return [t.projectId!, `프로젝트 “${t.projectName ?? t.projectId}”`];
    return ["-", "서버 전체"];
}

function Row({ d, it, t, reload }: { d: SettingDef; it: Item; t: SettingsTarget; reload: () => void }) {
    const scopes = d.scopes.filter((s) => s === "server" || (s === "project" && t.projectId) || (s === "session" && t.sessionId));
    const [scope, setScope] = useState<string>(initialScope(d, t));
    return <SettingValue key={scope} d={d} it={it} t={t} reload={reload} scope={scope} scopes={scopes} setScope={setScope} />;
}

export function useSettingAutosave({ d, it, t, reload, scope, onSaved }: {
    d: SettingDef; it: Item; t: SettingsTarget; reload: () => void; scope: string; onSaved?: (value: unknown) => void;
}) {
    const layer = it.layers[scope];
    const normalize = (item: Item) => {
        const value = item.layers[scope]?.value ?? item.effective;
        // 이전 간결하게 설정을 다섯 가지 스타일 중 심플로 표시한다.
        if (d.key === "output.style" && value === "concise") return "simple";
        return d.kind === "int" ? String(value ?? "") : value ?? "";
    };
    return useAutosave<unknown>({
        id: `${scope}:${scopeTarget(scope, t)[0]}:${d.key}`, value: normalize(it), revision: layer?.revision ?? 0,
        save: async (value, revision, key) => {
            if (d.kind === "int" && !/^-?\d+$/.test(String(value))) throw new ApiError(422, "invalid_input", "정수를 입력하세요.");
            try {
                const result = await api.put<{ item: Item }>(`/settings/${scope}/${scopeTarget(scope, t)[0]}/${d.key}`,
                    { expected_revision: revision, value: d.kind === "int" ? Number(value) : value }, { key });
                return { value: normalize(result.item), revision: result.item.layers[scope]!.revision };
            } finally { reload(); }
        },
        onSaved,
    });
}

function SettingValue({ d, it, t, reload, scope, scopes, setScope }: {
    d: SettingDef; it: Item; t: SettingsTarget; reload: () => void; scope: string; scopes: string[]; setScope: (scope: string) => void;
}) {
    const state = useSettingAutosave({ d, it, t, reload, scope });
    const value = state.value;
    const edit = state.change;
    const choose = (value: unknown) => { edit(value); state.commit(); };
    const [, target] = scopeTarget(scope, t);
    return (
        <GroveStack as="section" gap={2} padding={3} data-testid={`setting-${d.key}`} data-setting-key={d.key} data-settings-target={target}>
            <GroveStack gap={1.5} direction="horizontal" align="center" wrap="wrap">
            <GroveHeading level={2} color="inherit">{d.label}</GroveHeading>
            <HelpTip label={`${d.label} 도움말`}>
                <SentenceText text={d.description} />
                <GroveText type="inherit" color="inherit">{target} · {APPLIES[d.applies]}</GroveText>
                <GroveText type="inherit" color="inherit">실제 적용값: <code>{JSON.stringify(it.effective)}</code> ({SCOPE_LABEL[it.source]}) · 기본값 <code>{JSON.stringify(it.default)}</code></GroveText>
            </HelpTip>
            </GroveStack>
            <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
                {scopes.length > 1 && (
                    <Select disabled={state.phase === "saving" || state.phase === "uncertain"} label={`${d.label} 적용 범위`} hideLabel value={scope}
                        aria-description={scope === "server" ? "모든 기기·프로젝트에 적용" : target}
                        onChange={setScope}
                        options={scopes.map((value) => ({ value, label: SCOPE_LABEL[value] }))} />
                )}
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
                {(PROFILE_KEYS.has(d.key) || d.key.startsWith("agents.profile.")) && <ProfileChoice d={d} value={value} disabled={false} edit={choose} />}
                {((d.kind === "string" && !(PROFILE_KEYS.has(d.key) || d.key.startsWith("agents.profile."))) || d.kind === "tool_list") && (
                    <TextInput
                        label={d.label} isLabelHidden
                        placeholder={d.kind === "tool_list" ? "예: web_fetch, shell" : undefined}
                        value={String(value ?? "")}
                        onChange={edit}
                        onBlur={state.blur}
                    />
                )}
            </GroveStack>
            {d.key === "tools.mode" && (value === "bypass" || it.effective === "bypass") && (
                <GroveText as="p" display="block" type="supporting" color="warning">
                    <SentenceText text="파일 변경·명령 실행·외부 요청을 확인 없이 허용해요. 금지한 도구와 위임의 별도 정책은 유지돼요." />
                </GroveText>
            )}
            {d.key === "tools.full_access" && (Boolean(value) || Boolean(it.effective)) && (
                <GroveText as="p" display="block" type="supporting" color="warning">
                    셸이 프로젝트 밖 파일·네트워크·서버 계정의 자격증명에 접근할 수 있어요. 임의 명령을 허용하므로 신뢰하는 작업에만 켜세요.
                </GroveText>
            )}
            <AutosaveStatus state={state} applies={APPLIES[d.applies]} />
        </GroveStack>
    );
}
