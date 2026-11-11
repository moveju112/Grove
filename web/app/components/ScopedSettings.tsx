import { useState } from "react";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";

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

const SCOPE_LABEL: Record<string, string> = { server: "서버 전체", project: "이 프로젝트", session: "이 대화", default: "기본값" };
const APPLIES: Record<string, string> = { immediate: "즉시 적용", next_turn: "다음 요청부터 적용", restart: "재시작 후 적용" };
const ENUM_LABEL: Record<string, Record<string, string>> = { "output.style": { default: "모델 기본", concise: "간결하게", detailed: "자세하게" } };

/// 연 위치(프로젝트·대화)를 정확히 가리키는 대상 정보. 탭을 열 때 고정되어 pane 전환으로 바뀌지 않는다(CONFIG-005, SETTINGS-024).
export type SettingsTarget = { projectId?: string; projectName?: string; sessionId?: string; sessionTitle?: string };

/// 범위별 설정 편집기.
export function ScopedSettings({ defs, target }: { defs: SettingDef[]; target: SettingsTarget }) {
    const p = new URLSearchParams();
    if (target.sessionId) p.set("session_id", target.sessionId);
    else if (target.projectId) p.set("project_id", target.projectId);
    const eff = useQuery<{ items: Item[] }>(`settings:${target.sessionId ?? target.projectId ?? "-"}`, () => api.get(`/settings/effective?${p}`));
    return (
        <div className="scoped">
            {defs.map((d) => {
                const it = eff.data?.items.find((i) => i.key === d.key);
                return it ? <Row key={d.key} d={d} it={it} t={target} reload={eff.reload} /> : null;
            })}
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
    const [scope, setScope] = useState(scopes.includes("session") ? "session" : scopes.includes("project") ? "project" : "server");
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
        <section className="setting" data-testid={`setting-${d.key}`}>
            <h2>
                {d.label} {d.advanced && <span className="muted small">고급</span>}{" "}
                <a className="muted small" href={`#setting-${encodeURIComponent(d.key)}`} title="이 항목으로 바로 가는 링크" aria-label={`${d.label} 링크`}>#</a>
            </h2>
            <p className="muted small">{d.description}</p>
            <div className="inline wrap">
                {scopes.length > 1 && (
                    <select disabled={saving} aria-label={`${d.label} 적용 범위`} value={scope} onChange={(e) => { setScope(e.target.value); setDraft(undefined); setState({ kind: "idle" }); }}>
                        {scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                    </select>
                )}
                <span className="scope">대상: {target}</span>
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
                {(d.kind === "string" || d.kind === "tool_list") && (
                    <input
                        disabled={saving}
                        aria-label={d.label}
                        placeholder={d.kind === "tool_list" ? "예: shell, write_file" : undefined}
                        value={String(value ?? "")}
                        onChange={(e) => edit(e.target.value)}
                    />
                )}
                {d.kind === "text" && <textarea disabled={saving} aria-label={d.label} rows={4} value={String(value ?? "")} onChange={(e) => edit(e.target.value)} />}
                <button disabled={draft === undefined || saving || state.kind === "conflict"} onClick={() => draft && void save(draft.value, draft.revision)}>저장</button>
                {layer && layer.value !== null && layer.value !== undefined && (
                    <button disabled={saving} className="ghost" onClick={() => void save(null, layer.revision)} title="이 범위의 값을 지우고 상위 범위 값을 쓴다">이 범위 값 지우기</button>
                )}
            </div>
            <p className="muted small">
                실제 적용값: <code>{JSON.stringify(it.effective)}</code> ({SCOPE_LABEL[it.source]}) · 기본값 <code>{JSON.stringify(it.default)}</code>
                {draft !== undefined && <strong> · 저장 안 됨</strong>}
            </p>
            {state.kind !== "idle" && (
                <p className={`save-state ${state.kind === "error" || state.kind === "conflict" ? "error" : ""}`} role="status">
                    {state.kind === "saving" ? "저장 중…" : state.kind === "saved" ? `저장됨 · ${state.msg}` : state.kind === "conflict" ? state.msg : `저장 실패(기존 값 유지): ${state.msg}`}
                </p>
            )}
            {state.kind === "conflict" && (
                <div className="actions">
                    <button className="ghost" onClick={() => { setDraft(undefined); setState({ kind: "idle" }); }}>최신 값 사용</button>
                    {draft && <button onClick={() => void save(draft.value, layer?.revision ?? 0)}>내 수정으로 덮어쓰기</button>}
                </div>
            )}
        </section>
    );
}
