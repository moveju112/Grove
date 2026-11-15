import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from "@astryxdesign/core/Table";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../../api/client";
import type { DefinitionDetail } from "../../api/generated";
import { FIELDS, LABELS, loadAttempt, recoveryKey, restoreBody, type Attempt, type Field } from "./model";
import { ServerActionButton } from "../pwa/ServerActionButton";
import { BooleanSelect } from "../BooleanSelect";
import { HelpTip, SentenceText } from "../HelpTip";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";

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
        <GroveButton variant="secondary" disabled={disabled || locked || review.kind === "loading"} onClick={() => void compare()}>현재 번들 기본값과 비교</GroveButton>
        {review.kind !== "closed" && <>
            <GroveStack as="p" direction="horizontal" align="center" gap={1.5}>선택한 필드만 복원해. <HelpTip label="정의 복원 도움말">
                <SentenceText text="선택한 필드의 override만 지워 현재 번들 기본값을 사용해. 선택하지 않은 값·활성 상태·미저장 초안은 유지돼." />
            </HelpTip></GroveStack>
            {snapshot && <>
                <GroveText as="p" display="block" type="inherit" color="inherit">비교 revision {snapshot.revision} · {snapshot.enabled ? "활성" : "비활성"} · 원문 SHA-256 <code>{snapshot.baseline_sha256}</code></GroveText>
                <ScrollableArea axis="inline" label="정의 기본값 비교 표" maxWidth="100%"><Table density="compact">
                    <TableHeader><TableRow isHeaderRow><TableHeaderCell scope="col">선택</TableHeaderCell><TableHeaderCell scope="col">필드</TableHeaderCell><TableHeaderCell scope="col">현재 적용값</TableHeaderCell><TableHeaderCell scope="col">현재 번들 기본값</TableHeaderCell></TableRow></TableHeader>
                    <TableBody>{FIELDS.map((field) => <TableRow key={field} data-testid={`definition-compare-${field}`}>
                        <TableCell><BooleanSelect label={`${LABELS[field]} 기본값 적용`} hideLabel value={selected.includes(field)}
                            disabled={disabled || review.kind !== "ready"}
                            trueLabel="기본값 적용" falseLabel="현재 값 유지"
                            onChange={(value) => {
                                if (review.kind === "ready") setReview({ ...review, fields: value
                                    ? FIELDS.filter((f) => review.fields.includes(f) || f === field) : review.fields.filter((f) => f !== field) });
                            }} /></TableCell>
                        <TableHeaderCell scope="row">{LABELS[field]}</TableHeaderCell>
                        <TableCell><pre aria-label={`${LABELS[field]} 현재 적용값`}>{snapshot[field]}</pre></TableCell>
                        <TableCell><pre aria-label={`${LABELS[field]} 현재 번들 기본값`}>{snapshot[`baseline_${field}`]}</pre></TableCell>
                    </TableRow>)}</TableBody>
                </Table></ScrollableArea>
            </>}
            {draft !== undefined && <GroveStack gap={0}><GroveText as="p" display="block" type="inherit" color="warning">미저장 본문은 복원 후에도 초안으로 남고 자동 저장되지 않아.</GroveText><pre aria-label="보존할 미저장 초안">{draft}</pre></GroveStack>}
            {review.kind === "ready" && <ServerActionButton disabled={disabled || !review.fields.length} onClick={() => void restore({
                key: newKey(), definition: review.definition, fields: review.fields,
            })}>선택한 필드만 기본값 적용</ServerActionButton>}
            {review.kind === "ready" && draft !== undefined && <>
                <GroveText as="p" display="block" type="inherit" color="inherit">실제 저장 시 비교한 본문이 초안으로 교체돼.</GroveText>
                <GroveButton disabled={disabled} onClick={() => onDraftReviewed(review.definition)}>비교한 revision으로 초안 저장 준비</GroveButton>
            </>}
            {review.kind === "loading" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">비교하는 중…</GroveText>}
            {review.kind === "sending" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">선택한 기본값을 적용하는 중…</GroveText>}
            {(review.kind === "stale" || review.kind === "error" || review.kind === "uncertain") && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{review.message}</GroveText>}
            {review.kind === "stale" && <GroveButton disabled={disabled} onClick={() => void compare()}>변경된 값 다시 비교</GroveButton>}
            {review.kind === "uncertain" && <>
                <GroveText as="p" display="block" type="inherit" color="inherit">이미 적용됐을 수 있으니 원래 요청의 결과만 확인해.</GroveText>
                <ServerActionButton disabled={disabled} onClick={() => void restore(review.attempt)}>원래 복원 요청 결과 확인</ServerActionButton>
            </>}
            {review.kind === "saved" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">선택한 기본값 적용됨 · 미저장 초안은 유지했어.</GroveText>}
            {!locked && <GroveButton variant="secondary" disabled={review.kind === "loading"} onClick={() => setReview({ kind: "closed" })}>비교 취소</GroveButton>}
        </>}
    </section>;
}
