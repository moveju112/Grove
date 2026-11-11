import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { Worktree } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { useQuery } from "../state/store";

/// 이 화면이 쓰는 서버 기능(NET-001). 서버에 없으면 화면을 숨기고 요청은 서버가 거절한다.
const WT = ["worktrees_v1"];

type Row = Worktree & { exists: boolean; dirty_count: number | null; sessions: number };
type List = { is_repo: boolean; worktrees: Row[]; unowned: { path: string; branch: string | null }[] };
type Attempt = { label: string; target: string; key: string; run: (key: string) => Promise<unknown>; onSuccess?: () => void; onConflict?: (e: ApiError) => boolean };
type CreateOptions = { carry?: "leave" | "carry"; confirm_large?: boolean };
type Choice = ({ kind: "dirty"; changed: number } | { kind: "large"; files: number }) & { options: CreateOptions; name: string };

/// Grove worktree(GIT-007~010). Grove가 만든 것만 merge·제거하고, 사용자가 만든 worktree는 표시만 한다.
/// 응답을 받지 못한 요청은 같은 키로 결과를 다시 확인한다(새 요청으로 반복하지 않는다).
export function WorktreesPanel({ projectId }: { projectId: string }) {
    if (useCapability("worktrees_v1") === false) return null;
    return <WorktreesPanelBody projectId={projectId} />;
}

function WorktreesPanelBody({ projectId }: { projectId: string }) {
    const q = useQuery<List>(`worktrees:${projectId}`, () => api.get(`/projects/${projectId}/worktrees`, { requires: WT }));
    const [name, setName] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const [choice, setChoice] = useState<Choice | null>(null);
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [busy, setBusy] = useState(false);
    const active = useRef(false);
    const pending = useRef<Attempt | null>(null);
    const data = q.data;

    const act = async (a: Attempt) => {
        if (active.current || (pending.current && pending.current !== a)) return;
        active.current = true;
        pending.current = a;
        setBusy(true);
        setErr(null);
        setAttempt(a);
        try {
            await a.run(a.key);
            pending.current = null;
            setAttempt(null);
            a.onSuccess?.();
            return true;
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.code === "result_unknown"
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            if (!unknown) { pending.current = null; setAttempt(null); }
            if (e instanceof ApiError && a.onConflict?.(e)) return false;
            setErr(e instanceof ApiError ? e.message : `${a.label}: 응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인할 수 있습니다.`);
            return false;
        } finally {
            active.current = false;
            setBusy(false);
            q.reload();
        }
    };

    const create = (opts: CreateOptions, targetName = name.trim()) => {
        const body = { name: targetName, ...opts };
        void act({
            label: "worktree 만들기", target: `${projectId} · grove/${body.name}`, key: newKey(),
            run: (key) => api.post(`/projects/${projectId}/worktrees`, body, { key, requires: WT }),
            onConflict: (e) => {
                if (e.code === "worktree_dirty_choice") {
                    setChoice({ kind: "dirty", changed: (e.details as { changed: number }).changed, options: opts, name: body.name });
                    return true;
                }
                if (e.code === "worktree_large_repo") {
                    setChoice({ kind: "large", files: (e.details as { files: number }).files, options: opts, name: body.name });
                    return true;
                }
                return false;
            },
            onSuccess: () => {
                setName((current) => current.trim() === body.name ? "" : current);
                setChoice(null);
            },
        });
    };

    if (data && !data.is_repo && !attempt) return null;
    const rows = data?.worktrees ?? [];
    return (
        <details className="worktrees" data-testid="worktrees-panel">
            <summary>Worktree {rows.length > 0 ? `· ${rows.length}` : ""}</summary>
            {err && <p className="err" role="alert">{err}</p>}
            {Boolean(q.error) && <p className="err" role="alert">worktree 목록을 불러오지 못했습니다</p>}
            {busy && <p className="muted small" role="status">worktree 요청 처리·결과 확인 중…</p>}
            {attempt && !busy && <div className="notice" role="group" aria-label="worktree 결과 재확인">
                <p>{attempt.label} 결과 미확정 · <code>{attempt.target}</code>. 원래 요청과 같은 키로만 확인하며 자동 재실행하지 않습니다.</p>
                <button className="ghost small" onClick={() => void act(attempt)}>같은 요청 결과 확인</button>
                <button className="ghost small" onClick={() => {
                    if (!confirm("실제 폴더·브랜치·이력과 이전 작업의 결과를 확인했나요?\n이전 요청을 완료로 확정하거나 되돌리지 않습니다. 생성 미확정 worktree의 파일은 그대로 남습니다.")) return;
                    pending.current = null;
                    setAttempt(null);
                    setErr("이전 요청은 결과 불명 기록으로 남습니다. 다음 작업은 확인한 실제 상태에서 새 키로 시작합니다.");
                }}>상태 확인 후 새 작업 허용</button>
            </div>}
            <form
                className="inline"
                onSubmit={(e) => {
                    e.preventDefault();
                    setChoice(null);
                    create({});
                }}
            >
                <input aria-label="worktree 이름" placeholder="이름(브랜치 grove/이름)" value={name} onChange={(e) => setName(e.target.value)} required pattern="[A-Za-z0-9._\-]{1,60}" />
                <button className="small" type="submit" disabled={busy || attempt !== null || !name.trim()}>만들기</button>
            </form>
            {choice?.kind === "dirty" && (
                <div className="notice" role="group" aria-label="커밋하지 않은 변경 처리">
                    <p><code>grove/{choice.name}</code> · 프로젝트 폴더에 커밋하지 않은 변경 {choice.changed}개가 있습니다. 어느 쪽이든 프로젝트 폴더의 변경은 그대로 남습니다.</p>
                    <button className="small" disabled={busy || attempt !== null} onClick={() => create({ ...choice.options, carry: "leave" }, choice.name)}>두고 가기(변경 없이 시작)</button>
                    <button className="small" disabled={busy || attempt !== null} onClick={() => create({ ...choice.options, carry: "carry" }, choice.name)}>복사해 가기</button>
                    <button className="ghost small" onClick={() => setChoice(null)}>취소</button>
                </div>
            )}
            {choice?.kind === "large" && (
                <div className="notice" role="group" aria-label="큰 저장소 확인">
                    <p><code>grove/{choice.name}</code> · 추적 파일이 {choice.files.toLocaleString()}개인 큰 저장소입니다. 체크아웃에 시간과 디스크가 듭니다.</p>
                    <button className="small" disabled={busy || attempt !== null} onClick={() => create({ ...choice.options, confirm_large: true }, choice.name)}>그래도 만들기</button>
                    <button className="ghost small" onClick={() => setChoice(null)}>취소</button>
                </div>
            )}
            <ul className="session-list">
                {rows.map((w) => (
                    <li key={w.id} data-testid="worktree-row" data-status={w.status}>
                        <strong>{w.name}</strong> <code className="small">{w.branch}</code>{" "}
                        {w.status === "unknown" ? <span className="err small">생성 결과 미확정 · 파일 보존</span> : w.status === "missing" || !w.exists ? (
                            <span className="err small">경로 없음</span>
                        ) : (
                            <span className="muted small">{w.dirty_count ? `변경 ${w.dirty_count}개` : "깨끗함"}{w.sessions > 0 ? ` · 대화 ${w.sessions}개` : ""}</span>
                        )}
                        <code className="muted small"> {w.path}</code>
                        {w.status === "unknown" && w.exists && <button className="ghost small" disabled={busy || attempt !== null} onClick={() => {
                            if (!confirm("실제 폴더·브랜치와 복사된 파일을 검토했나요? 일부 파일이 복사되지 않았을 수 있습니다.\n이전 요청의 완료로 단정하지 않고, 확인한 현재 상태를 새 작업 위치로 사용합니다. 파일은 변경하지 않습니다.")) return;
                            void act({ label: "현재 상태 사용", target: w.path, key: newKey(), run: (key) => api.post(`/worktrees/${w.id}/review`, { reviewed: true }, { key, requires: WT }) });
                        }}>확인한 현재 상태 사용</button>}
                        {w.status === "active" && w.exists && (
                            <button
                                className="ghost small"
                                disabled={busy || attempt !== null}
                                onClick={() => {
                                    if (confirm(`${w.branch}를 프로젝트 폴더의 현재 브랜치에 merge할까요? 충돌하면 merge 전 상태로 되돌립니다.`))
                                        void act({ label: "merge", target: w.branch, key: newKey(), run: (key) => api.post(`/worktrees/${w.id}/merge`, {}, { key, requires: WT }) });
                                }}
                            >
                                merge
                            </button>
                        )}
                        <button
                            className="ghost small"
                            disabled={busy || attempt !== null || w.sessions > 0}
                            title={w.sessions > 0 ? "대화를 프로젝트 폴더로 돌린 뒤 제거할 수 있습니다" : undefined}
                            onClick={() => {
                                if (!confirm(`worktree를 제거할까요? 브랜치 ${w.branch}는 남습니다.`)) return;
                                // 변경 여부는 화면의 목록이 아니라 서버가 지금 확인한 결과로 판단한다.
                                const force = () => void act({ label: "강제 제거", target: w.path, key: newKey(), run: (key) => api.del(`/worktrees/${w.id}?force=true`, { key, requires: WT }) });
                                void act({
                                    label: "제거",
                                    target: w.path,
                                    key: newKey(),
                                    run: (key) => api.del(`/worktrees/${w.id}`, { key, requires: WT }),
                                    onConflict: (e) => {
                                        if (e.code !== "worktree_dirty") return false;
                                        const n = (e.details as { changed?: number } | undefined)?.changed ?? 0;
                                        if (confirm(`커밋하지 않은 변경 ${n}개가 사라집니다. 그래도 제거할까요? 브랜치 ${w.branch}는 남습니다.`)) setTimeout(force, 0);
                                        return true;
                                    },
                                });
                            }}
                        >
                            제거
                        </button>
                    </li>
                ))}
            </ul>
            {(data?.unowned.length ?? 0) > 0 && (
                <>
                    <p className="muted small">Grove가 만들지 않은 worktree(표시만 하고 변경하지 않음)</p>
                    <ul className="session-list">
                        {data!.unowned.map((u) => (
                            <li key={u.path} data-testid="worktree-unowned"><code className="small">{u.path}</code> {u.branch && <code className="muted small">{u.branch}</code>}</li>
                        ))}
                    </ul>
                </>
            )}
            {rows.some((w) => !w.exists) && (
                <button className="ghost small" disabled={busy || attempt !== null} onClick={() => void act({ label: "정리", target: projectId, key: newKey(), run: (key) => api.post(`/projects/${projectId}/worktrees/prune`, {}, { key, requires: WT }) })}>
                    사라진 worktree 기록 정리
                </button>
            )}
        </details>
    );
}

/// 대화의 작업 위치 선택(GIT-008): 프로젝트 폴더 또는 이 프로젝트의 Grove worktree. 실행 중이면 서버가 거절한다.
export function WorktreeSelect(props: { projectId: string; sessionId: string; current: string | null; disabled: boolean; onError: (m: string) => void }) {
    if (useCapability("worktrees_v1") === false) return null;
    return <WorktreeSelectBody {...props} />;
}

function WorktreeSelectBody({ projectId, sessionId, current, disabled, onError }: { projectId: string; sessionId: string; current: string | null; disabled: boolean; onError: (m: string) => void }) {
    const q = useQuery<List>(`worktrees:${projectId}`, () => api.get(`/projects/${projectId}/worktrees`, { requires: WT }));
    const rows = (q.data?.worktrees ?? []).filter((w) => w.status === "active" || w.id === current);
    if (!q.data?.is_repo || (rows.length === 0 && !current)) return null;
    return (
        <select
            aria-label="작업 위치"
            value={current ?? ""}
            disabled={disabled}
            onChange={(e) => {
                const worktree_id = e.target.value || null;
                api.post(`/sessions/${sessionId}/worktree`, { worktree_id }, { requires: WT }).catch((err: Error) => onError(`작업 위치를 바꾸지 못했습니다: ${err.message}`));
            }}
        >
            <option value="">위치: 프로젝트 폴더</option>
            {rows.map((w) => (
                <option key={w.id} value={w.id}>위치: worktree {w.name}{w.status !== "active" ? " (경로 없음)" : ""}</option>
            ))}
        </select>
    );
}
