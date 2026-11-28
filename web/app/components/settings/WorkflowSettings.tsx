import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import * as stylex from "@stylexjs/stylex";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import type { Definition } from "../../api/generated";
import { useQuery } from "../../state/store";
import { Select } from "../../design/Select";
import { Icon, type IconName } from "../icons";
import { HelpTip, SentenceText } from "../HelpTip";
import { useServerBlockReason } from "../pwa/lifecycle";
import { initialScope, ProfileChoice, profileChoiceValue, scopeTarget, useEffectiveSettings, useSettingAutosave,
    type SettingDef, type SettingItem, type SettingsTarget } from "../ScopedSettings";
import type { SettingLinkReady } from "../settings-links/reveal";
import { AutosaveStatus } from "./AutosaveStatus";
import { APPLIES, SCOPE_LABEL } from "./constants";
import { useAutosave } from "./useAutosave";
import { workflowStyles as styles } from "./workflow.stylex";

/// fallback: 이 작업 모델의 Claude·Codex 계정 한도를 다 썼을 때 쓸 모델. 지원하지 않는 서버는 항목이 없다.
type Feature = { id: string; label: string; icon: IconName; model: string; fallback: string; flag?: string };
const FEATURES: Feature[] = [
    { id: "title-generator", label: "대화 제목 자동 생성", icon: "panel", model: "session.title_profile", fallback: "session.title_fallback", flag: "session.auto_title" },
    { id: "context-compressor", label: "컨텍스트 압축", icon: "changes", model: "context.summary_profile", fallback: "context.summary_fallback" },
    { id: "context-explorer", label: "컨텍스트 탐색", icon: "search", model: "agents.profile.context-explorer", fallback: "agents.fallback.context-explorer" },
    { id: "failure-analyst", label: "실패 분석", icon: "file", model: "agents.profile.failure-analyst", fallback: "agents.fallback.failure-analyst" },
    { id: "handoff-summarizer", label: "인계 요약", icon: "file", model: "agents.profile.handoff-summarizer", fallback: "agents.fallback.handoff-summarizer" },
    { id: "maintainer", label: "Maintainer", icon: "server", model: "memory.profile", fallback: "memory.fallback", flag: "memory.enabled" },
];
const featureKeys = ({ model, fallback, flag }: Feature) => [model, fallback, flag].filter(Boolean) as string[];

export function isWorkflowSetting(key: string) {
    return FEATURES.some((feature) => featureKeys(feature).includes(key));
}

export function WorkflowSettings({ defs, target, linkedKey, matchedKeys, search, onLinkReady, renderRoleName, definitions }: {
    defs: SettingDef[]; target: SettingsTarget; linkedKey?: string; matchedKeys: string[]; search: string;
    onLinkReady: SettingLinkReady; renderRoleName: (role: Definition) => ReactNode; definitions: ReactNode;
}) {
    const panelId = useId();
    const [tab, setTab] = useState("workflow");
    const roles = useQuery<Definition[]>("definitions:agent", () => api.get("/definitions?kind=agent"));
    const server = useEffectiveSettings({});
    // 자동 제목과 메모리 정리만 프로젝트 override를 지원한다. 모델은 항상 서버 전체다.
    const project = useEffectiveSettings({ projectId: target.projectId });
    const linked = FEATURES.find((feature) => linkedKey && featureKeys(feature).includes(linkedKey));
    const match = search ? FEATURES.find((feature) => featureKeys(feature).some((key) => matchedKeys.includes(key))
        || feature.label.toLowerCase().includes(search)) : undefined;
    useLayoutEffect(() => {
        if (linked || match) setTab("workflow");
    }, [linked, match]);

    const error = Boolean(roles.error || server.error || project.error);
    const loaded = Boolean(roles.data && server.data && project.data && defs.length);
    const rows = FEATURES.flatMap((feature) => {
        const role = roles.data?.find((d) => d.id === feature.id);
        const model = defs.find((d) => d.key === feature.model);
        const item = server.data?.items.find((d) => d.key === feature.model);
        const flag = defs.find((d) => d.key === feature.flag);
        const projectFlag = project.data?.items.find((d) => d.key === feature.flag);
        const serverFlag = server.data?.items.find((d) => d.key === feature.flag);
        if (!role || !model || !item || (feature.flag && (!flag || !projectFlag || !serverFlag))) return [];
        const fallbackDef = defs.find((d) => d.key === feature.fallback);
        const fallbackItem = server.data?.items.find((d) => d.key === feature.fallback);
        return [{ feature, role, model, item, scoped: flag && projectFlag && serverFlag ? { d: flag, projectFlag, serverFlag } : undefined,
            fallback: fallbackDef && fallbackItem ? { d: fallbackDef, item: fallbackItem } : undefined }];
    });
    const missing = linked && !rows.some(({ feature }) => feature === linked);
    useLayoutEffect(() => {
        if (linkedKey && linked && (error || (loaded && missing))) onLinkReady(linkedKey, null);
    }, [error, loaded, missing, linkedKey, linked, onLinkReady]);
    return <Stack gap={2}>
        <TabList value={tab} onChange={setTab} role="tablist" aria-label="기본 역할·워크플로우" size="sm" hasDivider>
            <Tab value="roles" label="기본 역할" panelId={panelId} />
            <Tab value="workflow" label="워크플로우" panelId={panelId} />
        </TabList>
        {error && <Text type="supporting" color="error" role="alert">워크플로우 설정을 읽지 못했어요.</Text>}
        <Stack id={panelId} role="tabpanel" aria-label={tab === "roles" ? "기본 역할" : "워크플로우"} gap={1}>
            {tab === "roles" ? FEATURES.map(({ id }) => {
                const role = roles.data?.find((d) => d.id === id);
                return role && <Card key={id} padding={2} data-testid={`definition-${id}`}>
                    <Stack gap={1}>{renderRoleName(role)}<Text type="supporting" color="secondary">{role.description}</Text></Stack>
                </Card>;
            }) : <>
                {rows.map(({ feature, role, model, item, scoped, fallback }) => <WorkflowRow key={feature.id} feature={feature} role={role}
                    model={model} item={item} scoped={scoped} fallback={fallback} target={target}
                    linkedKey={linkedKey} onLinkReady={onLinkReady}
                    reloadServer={server.reload} reloadProject={project.reload} />)}
                {!search && definitions}
            </>}
        </Stack>
    </Stack>;
}

function isPending(phase: string) { return phase === "saving" || phase === "uncertain"; }

type WorkflowRowProps = {
    feature: Feature; role: Definition; model: SettingDef; item: SettingItem; target: SettingsTarget;
    scoped?: { d: SettingDef; projectFlag: SettingItem; serverFlag: SettingItem };
    fallback?: { d: SettingDef; item: SettingItem };
    linkedKey?: string; onLinkReady: SettingLinkReady;
    reloadServer: () => void; reloadProject: () => void;
};

function WorkflowRow(props: WorkflowRowProps) {
    const { role, scoped } = props;
    const enabled = useAutosave({
        id: `definition-enabled:${role.id}`, value: role.enabled, revision: role.revision,
        save: async (value, revision, key) => {
            const saved = await api.put<Definition>(`/definitions/agent/${role.id}`, { expected_revision: revision, enabled: value }, { key });
            return { value: saved.enabled, revision: saved.revision };
        },
    });
    const saveEnabled = (value: boolean) => { enabled.change(value); enabled.commit(); };
    return scoped ? <ScopedWorkflowRow {...props} scoped={scoped} enabled={enabled} saveEnabled={saveEnabled} />
        : <WorkflowRowView {...props} on={enabled.value} toggle={saveEnabled}
            locked={isPending(enabled.phase) || enabled.phase === "conflict"} statuses={<AutosaveStatus state={enabled} />} />;
}

function ScopedWorkflowRow({ scoped, enabled, saveEnabled, ...props }: WorkflowRowProps & {
    scoped: NonNullable<WorkflowRowProps["scoped"]>; enabled: ReturnType<typeof useAutosave<boolean>>;
    saveEnabled: (value: boolean) => void;
}) {
    const { target, feature, reloadServer, reloadProject } = props;
    const [scope, setScope] = useState(() => initialScope(scoped.d, target));
    const [, targetLabel] = scopeTarget(scope, target);
    // Scoped features also have a legacy server-wide role gate. Turning them off only
    // changes their scoped flag; a legacy-disabled role is restored on explicit opt-in.
    const flag = useSettingAutosave({ d: scoped.d, it: scope === "project" ? scoped.projectFlag : scoped.serverFlag,
        t: target, scope, reload: scope === "project" ? reloadProject : reloadServer,
        onSaved: (value) => { if (value === true && !enabled.value) saveEnabled(true); },
    });
    const locked = [enabled.phase, flag.phase].some((phase) => isPending(phase) || phase === "conflict");
    const toggle = (value: boolean) => {
        if (value !== flag.value) { flag.change(value); flag.commit(); }
        else saveEnabled(value);
    };
    return <WorkflowRowView {...props} on={enabled.value && flag.value === true} toggle={toggle} locked={locked} targetLabel={targetLabel}
        statuses={<><AutosaveStatus state={enabled} /><AutosaveStatus state={flag} applies={APPLIES[scoped.d.applies]} /></>}
        extra={<Stack direction="horizontal" align="center" gap={2} wrap="wrap">
            {target.projectId && <Select label={`${feature.label} 적용 범위`} hideLabel value={scope} disabled={locked}
                aria-description={targetLabel} onChange={setScope}
                options={["project", "server"].map((value) => ({ value, label: SCOPE_LABEL[value] }))} />}
            <HelpTip label={`${feature.label} 도움말`}><SentenceText text={scoped.d.description} />
                <Text type="supporting">스위치: {targetLabel} · 모델: 서버 전체</Text>
            </HelpTip>
        </Stack>} />;
}

function WorkflowRowView({ feature, model, item, fallback, linkedKey, onLinkReady, reloadServer,
    on, toggle, locked, targetLabel, extra, statuses }: WorkflowRowProps & {
    on: boolean; toggle: (value: boolean) => void; locked: boolean;
    targetLabel?: string; extra?: ReactNode; statuses: ReactNode;
}) {
    const header = useRef<HTMLDivElement>(null);
    const detail = useRef<HTMLDivElement>(null);
    const reason = useServerBlockReason();
    const selection = useSettingAutosave({ d: model, it: item, t: {}, scope: "server", reload: reloadServer });
    const saveSelection = (value: unknown) => { selection.change(value); selection.commit(); };
    const chooseModel = (value: unknown) => {
        if (profileChoiceValue(value) !== profileChoiceValue(selection.value)) saveSelection(value);
    };
    useLayoutEffect(() => {
        if (linkedKey === feature.flag && linkedKey) onLinkReady(linkedKey, header.current);
        if (linkedKey === model.key) onLinkReady(linkedKey, detail.current);
    }, [linkedKey, feature.flag, model.key, onLinkReady]);

    return <Card padding={0} data-testid={`workflow-${feature.id}`} xstyle={styles.row}>
        <Stack ref={header} direction="horizontal" align="center" gap={2} xstyle={styles.header}
            data-setting-key={feature.flag} data-settings-target={targetLabel} data-testid={feature.flag ? `setting-${feature.flag}` : undefined}>
            <span {...stylex.props(styles.icon)}><Icon name={feature.icon} size={14} color="secondary" /></span>
            <Text xstyle={styles.label}>{feature.label}</Text>
            <Stack direction="horizontal" align="center" gap={1} xstyle={styles.actions}>
                <Text type="supporting" color={on ? "inherit" : "secondary"} aria-hidden="true">{on ? "켜짐" : "꺼짐"}</Text>
                <Switch label={`${feature.label} 사용`} isLabelHidden value={on} size="sm" isDisabled={locked || !!reason}
                    disabledMessage={reason ?? undefined} onChange={toggle} />
            </Stack>
        </Stack>
        <Stack ref={detail} gap={2} padding={3} xstyle={styles.details}
            data-setting-key={model.key} data-testid={`setting-${model.key}`} data-settings-target="서버 전체">
            <ProfileChoice d={model} value={selection.value} disabled={!!reason || isPending(selection.phase) || selection.phase === "conflict"}
                edit={chooseModel} onEffortChange={saveSelection} workflow />
            {model.key === "session.title_profile" && !selection.value &&
                <Text type="supporting" color="secondary">모델을 선택하기 전에는 기존 제목이 유지돼요.</Text>}
            {fallback && <FallbackChoice {...fallback} linkedKey={linkedKey} onLinkReady={onLinkReady} reload={reloadServer} />}
            {extra}
        </Stack>
        <Stack gap={1} xstyle={styles.statuses}>
            <AutosaveStatus state={selection} applies={APPLIES[model.applies]} />
            {statuses}
        </Stack>
    </Card>;
}

/// 이 작업 모델의 Claude·Codex 계정 한도를 다 썼을 때 쓸 모델. 비우면 전환하지 않는다.
function FallbackChoice({ d, item, linkedKey, onLinkReady, reload }: {
    d: SettingDef; item: SettingItem; linkedKey?: string; onLinkReady: SettingLinkReady; reload: () => void;
}) {
    const row = useRef<HTMLDivElement>(null);
    const reason = useServerBlockReason();
    const state = useSettingAutosave({ d, it: item, t: {}, scope: "server", reload });
    const choose = (value: unknown) => {
        if (profileChoiceValue(value) === profileChoiceValue(state.value)) return;
        state.change(value);
        state.commit();
    };
    useLayoutEffect(() => {
        if (linkedKey === d.key) onLinkReady(linkedKey, row.current);
    }, [linkedKey, d.key, onLinkReady]);
    return <Stack ref={row} gap={1} xstyle={styles.fallback} data-setting-key={d.key} data-testid={`setting-${d.key}`} data-settings-target="서버 전체">
        <ProfileChoice d={d} value={state.value} caption="한도 소진 시" workflow edit={choose}
            disabled={!!reason || isPending(state.phase) || state.phase === "conflict"} />
        <AutosaveStatus state={state} applies={APPLIES[d.applies]} />
    </Stack>;
}
