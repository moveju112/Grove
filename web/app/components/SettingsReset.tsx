import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../api/client";
import { useCapability } from "../state/capabilities";
import { defaultPrefs, loadPrefs, restoredPrefs, savePrefs, type Prefs } from "../state/device";
import type { SettingDef, SettingsTarget } from "./ScopedSettings";

type Source = "server" | "project" | "session" | "default";
export const SCOPE_LABEL: Record<Source, string> & Record<string, string> = { server: "서버 전체", project: "이 프로젝트", session: "이 대화", default: "기본값" };
export const APPLIES: Record<SettingDef["applies"], string> = { immediate: "즉시 적용", next_turn: "다음 요청부터 적용", restart: "재시작 후 적용" };
type Target = { scope: string; scope_id: string; keys: string[]; project_id: string | null; session_id: string | null };
type Resolved = { default: unknown; effective: unknown; source: Source; layers: Record<string, { value: unknown; revision: number }> };
type Plan = { target: Target; owner: string; fingerprint: string; items: { key: string; label: string; before: Resolved; after: Resolved; changed: boolean; applies: SettingDef["applies"] }[] };
type Attempt = { key: string; body: { target: Target; expected_fingerprint: string; expected_owner: string } };
type Review =
    | { kind: "loading" }
    | { kind: "load_error"; message: string }
    | { kind: "ready"; plan: Plan }
    | { kind: "sending"; plan: Plan; attempt: Attempt }
    | { kind: "uncertain"; plan: Plan; attempt: Attempt; message: string }
    | { kind: "stale"; plan: Plan; message: string }
    | { kind: "saved"; count: number };
type Comparison = { key: string; label: string; override: unknown; before: unknown; after: unknown; default: unknown; source: string; applies: string };

function Dialog({ children, busy, close }: { children: ReactNode; busy: boolean; close: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current!.showModal(); }, []);
    return <dialog ref={dialog} className="dialog settings-reset-dialog" aria-label="기본값 복원 확인" onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
        {children}
        <button className="ghost" disabled={busy} onClick={close}>복원 창 닫기</button>
    </dialog>;
}

function ComparisonTable({ rows }: { rows: Comparison[] }) {
    return <div className="settings-reset-table"><table>
        <thead><tr><th>항목</th><th>현재 범위 값</th><th>현재 적용값</th><th>복원 후 적용값</th><th>제품 기본값</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key} data-testid={`reset-${row.key}`}>
            <th>{row.label}<span className="muted small"> · {row.applies}</span></th>
            <td><code>{row.override === null ? "override 없음" : JSON.stringify(row.override)}</code></td>
            <td><code>{JSON.stringify(row.before)}</code></td>
            <td><code>{JSON.stringify(row.after)}</code><span className="muted small"> · {row.source}</span></td>
            <td><code>{JSON.stringify(row.default)}</code></td>
        </tr>)}</tbody>
    </table></div>;
}

export function SettingsResetButton({ defs, target, scope, scopeId, targetLabel, label, disabled, draft, saved }: {
    defs: SettingDef[]; target: SettingsTarget; scope: string; scopeId: string; targetLabel: string; label: string;
    disabled?: boolean; draft?: unknown; saved: () => void;
}) {
    const supported = useCapability("settings_reset_v1");
    const [review, setReview] = useState<Review | null>(null);
    const [owner] = useState(authGeneration);
    const alive = useRef(true);
    const reading = useRef<AbortController | null>(null);
    const working = useRef(false);
    const active = () => alive.current && owner === authGeneration() && isLoggedIn();
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; reading.current?.abort(); };
    }, []);
    const compare = async () => {
        reading.current?.abort();
        const controller = new AbortController();
        reading.current = controller;
        setReview({ kind: "loading" });
        const query = new URLSearchParams({ scope, scope_id: scopeId, keys: defs.map((d) => d.key).join(",") });
        if (target.projectId) query.set("project_id", target.projectId);
        if (target.sessionId) query.set("session_id", target.sessionId);
        try {
            const plan = await api.get<Plan>(`/settings/reset-preview?${query}`, { signal: controller.signal });
            if (active() && !controller.signal.aborted) setReview({ kind: "ready", plan });
        } catch (error) {
            if (active() && !controller.signal.aborted) setReview({ kind: "load_error", message: error instanceof Error ? error.message : "복원 전 값을 읽지 못했습니다." });
        }
    };
    const restore = async (plan: Plan, original?: Attempt) => {
        if (working.current || !active()) return;
        working.current = true;
        const attempt = original ?? { key: newKey(), body: { target: plan.target, expected_fingerprint: plan.fingerprint, expected_owner: plan.owner } };
        setReview({ kind: "sending", plan, attempt });
        try {
            const result = await api.post<{ changed: string[] }>("/settings/reset", attempt.body, { key: attempt.key, requires: ["settings_reset_v1"] });
            if (!active()) return;
            saved();
            setReview({ kind: "saved", count: result.changed.length });
        } catch (error) {
            if (!active()) return;
            const message = error instanceof Error ? error.message : "복원 결과를 확인하지 못했습니다.";
            if (error instanceof ApiError && error.status < 500 && !error.retryable && error.code !== "result_unknown") setReview({ kind: "stale", plan, message });
            else setReview({ kind: "uncertain", plan, attempt, message });
        } finally { working.current = false; }
    };
    if (supported === false) return null;
    const plan = review && "plan" in review ? review.plan : null;
    const busy = review?.kind === "sending";
    const close = () => { reading.current?.abort(); setReview(null); };
    return <>
        <button className="ghost" disabled={disabled || !defs.length} onClick={() => void compare()}>{label}</button>
        {review && <Dialog busy={busy} close={close}>
            <h2>기본값 복원 확인</h2>
            <p data-testid="reset-target">대상: <strong>{targetLabel}</strong></p>
            <p className="muted small">선택한 범위의 override만 지웁니다. 상위 범위 값을 상속하고 하위 범위 override는 유지하므로 제품 기본값과 다를 수 있습니다. 도구 금지 정책과 시스템 제약도 그대로 적용됩니다.</p>
            {scope === "server" && <p className="warn">모든 기기·프로젝트에 영향을 줄 수 있습니다. 아래 적용값은 이 설정 탭의 대상 기준이며 다른 프로젝트의 override는 지우지 않습니다.</p>}
            {draft !== undefined && <p className="warn">미저장 입력 <code>{JSON.stringify(draft)}</code>은 복원 성공 후 버립니다. 취소·충돌·실패 시에는 보존합니다.</p>}
            {review.kind === "loading" && <p role="status">범위별 값을 비교하는 중…</p>}
            {plan && <ComparisonTable rows={plan.items.map((item) => ({
                key: item.key, label: item.label, override: item.before.layers[plan.target.scope]?.value ?? null,
                before: item.before.effective, after: item.after.effective, default: item.before.default,
                source: SCOPE_LABEL[item.after.source], applies: APPLIES[item.applies],
            }))} />}
            {(review.kind === "load_error" || review.kind === "stale" || review.kind === "uncertain") && <p className="err" role="alert">{review.message}</p>}
            {(review.kind === "load_error" || review.kind === "stale") && <button onClick={() => void compare()}>변경된 값 다시 비교</button>}
            {review.kind === "ready" && <button onClick={() => void restore(review.plan)}>확인한 범위 복원</button>}
            {review.kind === "sending" && <p role="status">복원 저장 중…</p>}
            {review.kind === "uncertain" && <>
                <p className="warn">응답 유실만으로 미실행을 뜻하지 않습니다. 창을 닫아도 접수한 복원은 취소되지 않습니다.</p>
                <button onClick={() => void restore(review.plan, review.attempt)}>원래 복원 요청 결과 확인</button>
            </>}
            {review.kind === "saved" && <p role="status">복원 저장됨 · {review.count}개 override를 지웠습니다. 미저장된 다른 입력은 저장하지 않았습니다.</p>}
        </Dialog>}
    </>;
}

const PREF_LABEL: Record<keyof Prefs, string> = {
    theme: "테마", fontSize: "글자 크기", enterToSend: "Enter로 보내기", reasoning: "생각 과정 표시", answerOnly: "답만 보기", expandTools: "도구 세부 펼침",
};
type DeviceReview = { kind: "review" | "error"; before: Prefs; message?: string } | { kind: "saved" };
export function DeviceSettingsReset({ fields, label }: { fields: (keyof Prefs)[]; label: string }) {
    const [review, setReview] = useState<DeviceReview | null>(null);
    const compare = () => setReview({ kind: "review", before: loadPrefs() });
    const restore = () => {
        if (!review || review.kind === "saved") return;
        try {
            savePrefs(restoredPrefs(loadPrefs(), review.before, fields));
            setReview({ kind: "saved" });
        } catch (error) {
            setReview({ kind: "error", before: review.before, message: error instanceof Error ? error.message : "기기 설정을 저장하지 못했습니다." });
        }
    };
    return <>
        <button className="ghost small" onClick={compare}>{label}</button>
        {review && <Dialog busy={false} close={() => setReview(null)}>
            <h2>기본값 복원 확인</h2>
            <p data-testid="reset-target">대상: <strong>이 기기의 화면·입력 설정</strong></p>
            <p className="muted small">선택한 표시 설정만 바꿉니다. 서버 설정·다른 기기·기기 ID·대화·초안·배치는 지우지 않습니다.</p>
            {review.kind !== "saved" && <ComparisonTable rows={fields.map((key) => ({
                key, label: PREF_LABEL[key], override: review.before[key], before: review.before[key], after: defaultPrefs[key],
                default: defaultPrefs[key], source: "이 기기 기본값", applies: "즉시 적용",
            }))} />}
            {review.kind === "review" && <button onClick={restore}>확인한 범위 복원</button>}
            {review.kind === "error" && <>
                <p className="err" role="alert">{review.message}</p>
                <button onClick={compare}>변경된 값 다시 비교</button>
            </>}
            {review.kind === "saved" && <p role="status">복원 저장됨 · 이 기기의 선택한 표시 설정만 바꿨습니다.</p>}
        </Dialog>}
    </>;
}
