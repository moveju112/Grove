import { useLayoutEffect, useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
import { Icon } from "./icons";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";
import type { ModelProfile } from "../api/generated";
import { APPLIES, SCOPE_LABEL, SettingsResetButton } from "./SettingsReset";
import { ServerActionButton } from "./pwa/ServerActionButton";
import type { SettingLinkReady } from "./settings-links/reveal";
import { SettingsGroup } from "./SettingsGroup";

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
    "instructions.mode": { agents_md: "AGENTS.md만 전달", claude_md: "CLAUDE.md만 전달", both: "두 지침 파일 전달", off: "지침 파일 전달 안 함" },
};
const PROFILE_KEYS = new Set(["model.default_profile", "context.summary_profile"]);

function ProfileChoice({ d, value, disabled, edit }: { d: SettingDef; value: unknown; disabled: boolean; edit: (value: string) => void }) {
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const id = String(value ?? "");
    const selected = profiles.data?.find((profile) => profile.id === id);
    return <div className="setting-profile-choice">
        <select aria-label={d.label} value={id} disabled={disabled || !profiles.data} onChange={(event) => edit(event.target.value)}>
            <option value="">{d.key === "context.summary_profile" ? "요청에 쓰는 모델 사용" : "기기 선택 또는 첫 활성 모델"}</option>
            {id && profiles.data && !selected && <option value={id} disabled>사용 불가 모델(삭제됐거나 접근 불가)</option>}
            {(profiles.data ?? []).map((profile) => <option key={profile.id} value={profile.id} disabled={profile.enabled === false}>
                {profile.name} · {profile.protocol} · {profile.model}{profile.enabled === false ? " · 비활성" : ""}
            </option>)}
        </select>
        {selected && <span className="muted small"> 전송 대상: {selected.base_url || "서버 설치 CLI"} · {selected.model}</span>}
        {id && profiles.data && (!selected || selected.enabled === false) && <p className="warn small" role="status">현재 모델을 사용할 수 없습니다. 다른 모델로 자동 전환하지 않습니다.</p>}
        {Boolean(profiles.error) && <p className="err" role="alert">모델 목록을 읽지 못했습니다. <button className="ghost small" onClick={profiles.reload}>다시 읽기</button></p>}
    </div>;
}

/// 연 위치(프로젝트·대화)를 정확히 가리키는 대상 정보. 탭을 열 때 고정되어 pane 전환으로 바뀌지 않는다(CONFIG-005, SETTINGS-024).
export type SettingsTarget = { projectId?: string; projectName?: string; sessionId?: string; sessionTitle?: string };

/// 범위별 설정 편집기.
const SETTING_GROUPS: Record<string, string> = {
    model: "기본 모델", instructions: "대화·응답", output: "대화·응답", user: "대화·응답",
    session: "대화·응답", sessions: "대화·응답", context: "컨텍스트",
    agents: "에이전트 실행", tools: "도구·권한", runs: "실행 한도",
    storage: "보관·정리", approval: "승인",
};

function initialScope(d: SettingDef, target: SettingsTarget) {
    return target.sessionId && d.scopes.includes("session") ? "session"
        : target.projectId && d.scopes.includes("project") ? "project" : "server";
}

export function ScopedSettings({ defs, target, resetDefs, area, linkedKey, onLinkReady, grouped = false }: {
    defs: SettingDef[]; target: SettingsTarget; resetDefs?: SettingDef[]; area?: string;
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
    const scopes = ["server", ...(target.projectId ? ["project"] : []), ...(target.sessionId ? ["session"] : [])];
    const [resetScope, setResetScope] = useState(scopes.at(-1)!);
    const [resetId, resetLabel] = scopeTarget(resetScope, target);
    const groups = new Map<string, SettingDef[]>();
    for (const definition of defs) {
        const title = SETTING_GROUPS[definition.key.split(".")[0]!] ?? "기본 설정";
        const group = groups.get(title);
        if (group) group.push(definition);
        else groups.set(title, [definition]);
    }
    const renderRow = (d: SettingDef) => {
        const it = eff.data?.items.find((i) => i.key === d.key);
        return it ? <Row key={d.key} d={d} it={it} t={target} reload={eff.reload} /> : null;
    };
    return (
        <div className={`scoped${grouped ? " scoped-groups" : ""}`} ref={root}>
            {grouped ? Array.from(groups, ([title, definitions]) => <SettingsGroup key={title} title={title}
                scope={[...new Set(definitions.map((definition) => scopeTarget(initialScope(definition, target), target)[1]))].join(" · ")}>
                {definitions.map(renderRow)}
            </SettingsGroup>) : defs.map(renderRow)}
            {resetDefs && <DetailDialog className="settings-area-reset" data-testid="settings-area-reset" label={`${area} 기본값 복원`} title={`${area} 기본값 복원`}>
                <p className="muted small">고급 항목 포함. 모델 프로필·키·정의 파일은 유지됩니다.</p>
                <div className="inline wrap">
                    <select aria-label="영역 복원 범위" value={resetScope} onChange={(event) => setResetScope(event.target.value)}>
                        {scopes.map((scope) => <option key={scope} value={scope}>{SCOPE_LABEL[scope]}</option>)}
                    </select>
                    <SettingsResetButton key={resetScope} defs={resetDefs.filter((d) => d.scopes.includes(resetScope))}
                        target={target} scope={resetScope} scopeId={resetId} targetLabel={resetLabel} label="이 영역의 범위별 설정 복원" saved={eff.reload} />
                </div>
            </DetailDialog>}
        </div>
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
    // 가장 좁은 범위를 기본으로 고른다(연 위치에 맞춤).
    const [scope, setScope] = useState<string>(initialScope(d, t));
    const layer = it.layers[scope];
    // SSE가 최신 값을 가져와도 편집 시작 시점의 revision은 바꾸지 않는다(NET-013).
    const [draft, setDraft] = useState<{ value: unknown; revision: number } | undefined>(undefined);
    const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "error" | "conflict"; msg?: string }>({ kind: "idle" });
    const value = draft !== undefined ? draft.value : (layer?.value ?? it.effective);
    const saving = state.kind === "saving";
    const edit = (value: unknown) => {
        setDraft((prev) => ({ value, revision: prev?.revision ?? layer?.revision ?? 0 }));
        if (state.kind !== "conflict") setState({ kind: "idle" });
    };
    const save = async (v: unknown, revision: number) => {
        setState({ kind: "saving" });
        try {
            const [id] = scopeTarget(scope, t);
            await api.put(`/settings/${scope}/${id}/${d.key}`, { expected_revision: revision, value: v });
            setDraft(undefined);
            setState({ kind: "saved", msg: APPLIES[d.applies] });
        } catch (e) {
            if (e instanceof ApiError && e.code === "revision_conflict") setState({ kind: "conflict", msg: "다른 기기에서 먼저 바뀌었습니다. 내 수정은 보존했습니다" });
            else setState({ kind: "error", msg: e instanceof ApiError ? e.message : "저장 실패" });
        }
        reload();
    };
    const [, target] = scopeTarget(scope, t);
    return (
        <section className="setting" data-testid={`setting-${d.key}`} data-setting-key={d.key}>
            <div className="setting-heading">
            <h2>
                {d.label} {d.advanced && <span className="muted small">고급</span>}{" "}
                <a className="muted small" href={`#setting-${encodeURIComponent(d.key)}`} title="이 항목으로 바로 가는 링크" aria-label={`${d.label} 링크`}>#</a>
            </h2>
            <DetailDialog className="setting-help" label={`${d.label} 도움말`} title={`${d.label} 도움말`} trigger={<Icon name="help" size={16} />}>
                <div>
                    <p>{d.description}</p>
                    <p>실제 적용값: <code>{JSON.stringify(it.effective)}</code> ({SCOPE_LABEL[it.source]}) · 기본값 <code>{JSON.stringify(it.default)}</code></p>
                </div>
            </DetailDialog>
            </div>
            <div className="inline wrap">
                {scopes.length > 1 && (
                    <select disabled={saving} aria-label={`${d.label} 적용 범위`} value={scope} onChange={(e) => { setScope(e.target.value); setDraft(undefined); setState({ kind: "idle" }); }}>
                        {scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                    </select>
                )}
                <span className="scope" data-settings-target={target}>대상: {target}</span>
                {d.kind === "bool" && (
                    <label className="check">
                        <input disabled={saving} type="checkbox" checked={Boolean(value)} onChange={(e) => edit(e.target.checked)} aria-label={d.label} /> 사용
                    </label>
                )}
                {d.kind === "enum" && (
                    <select disabled={saving} aria-label={d.label} value={String(value ?? "")} onChange={(e) => edit(e.target.value)}>
                        {d.options.map((o) => <option key={o} value={o}>{ENUM_LABEL[d.key]?.[o] ?? o}</option>)}
                    </select>
                )}
                {d.kind === "int" && (
                    <input disabled={saving} type="number" aria-label={d.label} min={d.min ?? undefined} max={d.max ?? undefined} value={Number(value ?? 0)} onChange={(e) => edit(Number(e.target.value))} />
                )}
                {PROFILE_KEYS.has(d.key) && <ProfileChoice d={d} value={value} disabled={saving} edit={edit} />}
                {((d.kind === "string" && !PROFILE_KEYS.has(d.key)) || d.kind === "tool_list") && (
                    <input
                        disabled={saving}
                        aria-label={d.label}
                        placeholder={d.kind === "tool_list" ? "예: shell, write_file" : undefined}
                        value={String(value ?? "")}
                        onChange={(e) => edit(e.target.value)}
                    />
                )}
                {d.kind === "text" && <textarea disabled={saving} aria-label={d.label} rows={4} value={String(value ?? "")} onChange={(e) => edit(e.target.value)} />}
                <ServerActionButton disabled={draft === undefined || saving || state.kind === "conflict"} onClick={() => draft && void save(draft.value, draft.revision)}>저장</ServerActionButton>
                <SettingsResetButton compact key={scope} defs={[d]} target={t} scope={scope} scopeId={scopeTarget(scope,t)[0]} targetLabel={target}
                    label="이 범위 값 지우기" disabled={saving || layer?.value === null || layer?.value === undefined} draft={draft?.value}
                    saved={() => { setDraft(undefined); setState({ kind: "saved", msg: APPLIES[d.applies] }); reload(); }} />
            </div>
            {draft !== undefined && <p className="muted small" data-settings-unsaved="true">저장 안 됨</p>}
            {state.kind !== "idle" && (
                <p className={`save-state ${state.kind === "error" || state.kind === "conflict" ? "error" : ""}`} role="status">
                    {state.kind === "saving" ? "저장 중…" : state.kind === "saved" ? `저장됨 · ${state.msg}` : state.kind === "conflict" ? state.msg : `저장 실패(기존 값 유지): ${state.msg}`}
                </p>
            )}
            {state.kind === "conflict" && (
                <div className="actions">
                    <button className="ghost" onClick={() => { setDraft(undefined); setState({ kind: "idle" }); }}>최신 값 사용</button>
                    {draft && <ServerActionButton onClick={() => void save(draft.value, layer?.revision ?? 0)}>내 수정으로 덮어쓰기</ServerActionButton>}
                </div>
            )}
        </section>
    );
}
