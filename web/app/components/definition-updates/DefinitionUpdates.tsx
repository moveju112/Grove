import { useEffect, useRef, useState } from "react";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../../api/client";
import type { DefinitionDetail } from "../../api/generated";
import { FIELDS, LABELS, loadAttempt, recoveryKey, restoreBody, type Attempt, type Field } from "./model";
import "./definition-updates.css";

type Review =
    | { kind: "closed" | "loading" }
    | { kind: "ready"; definition: DefinitionDetail; fields: Field[] }
    | { kind: "sending" | "uncertain"; attempt: Attempt; message?: string }
    | { kind: "stale" | "error"; message: string }
    | { kind: "saved" };

export function DefinitionUpdates({ definition, draft, disabled, onLocked, onApplied, onDraftReviewed }: {
    definition: DefinitionDetail; draft?: string; disabled?: boolean;
    onLocked: (locked: boolean) => void; onApplied: () => void;
    onDraftReviewed: (definition: DefinitionDetail) => void;
}) {
    const { kind, id } = definition;
    const [review, setReview] = useState<Review>(() => {
        try {
            const attempt = loadAttempt(localStorage, kind, id);
            return attempt ? { kind: "uncertain", attempt, message: "이전 복원 요청의 결과를 같은 키로 확인하세요." } : { kind: "closed" };
        } catch (error) { return { kind: "error", message: String(error) }; }
    });
    const [owner] = useState(authGeneration);
    const working = useRef(false);
    const alive = useRef(true);
    const locked = review.kind === "sending" || review.kind === "uncertain" || review.kind === "error";
    useEffect(() => { onLocked(locked); }, [locked, onLocked]);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const active = () => alive.current && owner === authGeneration() && isLoggedIn();
    const compare = async () => {
        if (working.current || locked || !active()) return;
        working.current = true;
        setReview({ kind: "loading" });
        try {
            const current = await api.get<DefinitionDetail>(`/definitions/${kind}/${id}`);
            if (active()) setReview({ kind: "ready", definition: current, fields: [] });
        } catch (error) {
            if (active()) setReview({ kind: "stale", message: error instanceof Error ? error.message : "비교할 값을 읽지 못했습니다." });
        } finally { working.current = false; }
    };
    const restore = async (attempt: Attempt) => {
        if (working.current || !active()) return;
        working.current = true;
        // 전송 전에 원래 본문과 키를 남긴다. 저장 실패 시 mutation하지 않는다.
        try {
            const previous = loadAttempt(localStorage, kind, id);
            if (previous && previous.key !== attempt.key) {
                setReview({ kind: "uncertain", attempt: previous, message: "먼저 접수한 복원 요청의 결과를 확인하세요." });
                working.current = false;
                return;
            }
            localStorage.setItem(recoveryKey(kind, id), JSON.stringify(attempt));
        }
        catch {
            setReview({ kind: "error", message: "기기 저장 공간에 복구 요청을 보존하지 못해 전송하지 않았습니다. 저장 공간을 확인하고 다시 여세요." });
            working.current = false;
            return;
        }
        setReview({ kind: "sending", attempt });
        try {
            await api.post<DefinitionDetail>(`/definitions/${kind}/${id}/restore`, restoreBody(attempt), { key: attempt.key });
            if (!active()) return;
            localStorage.removeItem(recoveryKey(kind, id));
            onApplied();
            setReview({ kind: "saved" });
        } catch (error) {
            if (!active()) return;
            const message = error instanceof Error ? error.message : "복원 결과를 확인하지 못했습니다.";
            if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !error.retryable) {
                localStorage.removeItem(recoveryKey(kind, id));
                setReview({ kind: "stale", message: `${message} 선택을 초기화하고 다시 비교하세요.` });
            } else setReview({ kind: "uncertain", attempt, message });
        } finally { working.current = false; }
    };
    const snapshot = review.kind === "ready" ? review.definition : "attempt" in review ? review.attempt.definition : null;
    const selected = review.kind === "ready" ? review.fields : "attempt" in review ? review.attempt.fields : [];
    return <section aria-label="정의 기본값 비교">
        <button className="ghost" disabled={disabled || locked || review.kind === "loading"} onClick={() => void compare()}>현재 번들 기본값과 비교</button>
        {review.kind !== "closed" && <>
            <p>명시적으로 선택한 필드의 override만 지워 현재 번들 기본값을 사용해. 선택하지 않은 값·활성 상태·미저장 초안은 유지돼.</p>
            {snapshot && <>
                <p>비교 revision {snapshot.revision} · {snapshot.enabled ? "활성" : "비활성"} · 원문 SHA-256 <code>{snapshot.baseline_sha256}</code></p>
                <div className="definition-updates-table"><table>
                    <thead><tr><th>선택</th><th>필드</th><th>현재 적용값</th><th>현재 번들 기본값</th></tr></thead>
                    <tbody>{FIELDS.map((field) => <tr key={field} data-testid={`definition-compare-${field}`}>
                        <td><input type="checkbox" aria-label={`${LABELS[field]} 기본값 적용`} checked={selected.includes(field)}
                            disabled={disabled || review.kind !== "ready"}
                            onChange={(event) => {
                                if (review.kind === "ready") setReview({ ...review, fields: event.target.checked
                                    ? FIELDS.filter((f) => review.fields.includes(f) || f === field) : review.fields.filter((f) => f !== field) });
                            }} /></td>
                        <th>{LABELS[field]}</th>
                        <td><pre aria-label={`${LABELS[field]} 현재 적용값`}>{snapshot[field]}</pre></td>
                        <td><pre aria-label={`${LABELS[field]} 현재 번들 기본값`}>{snapshot[`baseline_${field}`]}</pre></td>
                    </tr>)}</tbody>
                </table></div>
            </>}
            {draft !== undefined && <div><p className="warn">미저장 본문은 복원 후에도 초안으로 남고 자동 저장되지 않아.</p><pre aria-label="보존할 미저장 초안">{draft}</pre></div>}
            {review.kind === "ready" && <button disabled={disabled || !review.fields.length} onClick={() => void restore({
                key: newKey(), definition: review.definition, fields: review.fields,
            })}>선택한 필드만 기본값 적용</button>}
            {review.kind === "ready" && draft !== undefined && <>
                <p>초안을 저장하면 비교한 현재 본문을 초안으로 바꿔. 저장 준비만으로 서버 값은 바뀌지 않아.</p>
                <button disabled={disabled} onClick={() => onDraftReviewed(review.definition)}>비교한 revision으로 초안 저장 준비</button>
            </>}
            {review.kind === "loading" && <p role="status">비교하는 중…</p>}
            {review.kind === "sending" && <p role="status">선택한 기본값을 적용하는 중…</p>}
            {(review.kind === "stale" || review.kind === "error" || review.kind === "uncertain") && <p className="err" role="alert">{review.message}</p>}
            {review.kind === "stale" && <button disabled={disabled} onClick={() => void compare()}>변경된 값 다시 비교</button>}
            {review.kind === "uncertain" && <>
                <p>응답이 유실돼도 적용됐을 수 있어. 새 복원 대신 원래 요청의 결과만 확인해. 화면을 다시 열어도 복구 요청은 남아.</p>
                <button disabled={disabled} onClick={() => void restore(review.attempt)}>원래 복원 요청 결과 확인</button>
            </>}
            {review.kind === "saved" && <p role="status">선택한 기본값 적용됨 · 미저장 초안은 유지했어.</p>}
            {!locked && <button className="ghost" disabled={review.kind === "loading"} onClick={() => setReview({ kind: "closed" })}>비교 취소</button>}
        </>}
    </section>;
}
