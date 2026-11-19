import { CodeBlock } from "../design/CodeBlock";
import { Code } from "@astryxdesign/core/Code";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useRef, useState } from "react";
import { Panel } from "./ui/Controls";
import { ApiError, api, authGeneration, newKey } from "../api/client";
import type { FileChange, FileChangePage } from "../api/generated";
import { useQuery } from "../state/store";
import { createContentCache, textBytes } from "../state/contentCache";
import type { Opener } from "./Workspace";
import { isArtifact } from "../state/artifactPreview";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { HelpTip, SentenceText } from "./HelpTip";
import { gitPanelStyles } from "./git/git-panel.stylex";

const OP: Record<string, string> = { created: "새 파일", modified: "수정", deleted: "삭제" };

type Attempt = { op: "undo" | "redo"; ids: string[]; key: string };

/// 최근 연 파일 변경 patch(변경 ID별).
const changeDiffs = createContentCache<string>({ maxBytes: 2 * 1024 * 1024, maxEntries: 100, size: (text) => textBytes(text) });

type Review = { files: { path: string; diff?: string; unavailable?: string; unchanged: boolean }[] };

/// 이 대화의 도구가 바꾼 파일(GIT-011~014). 대화 되감기(rewind)와는 별개로, 파일만 되돌리거나 다시 적용한다.
/// 되돌리기는 파일이 기록 뒤 바뀌지 않았을 때만 하고, 충돌이면 아무 파일도 바꾸지 않는다.
export function ChangesPanel({ sessionId, projectId, open, disabled }: { sessionId: string; projectId: string; open: Opener; disabled: boolean }) {
    const [cursors, setCursors] = useState<(number | null)[]>([null]);
    const cursor = cursors.at(-1);
    const q = useQuery<FileChangePage>(`changes:${sessionId}:page:${cursor ?? "latest"}`,
        () => api.getContract("FileChangePage", `/sessions/${sessionId}/file-changes/page?limit=50${cursor ? `&before_seq=${cursor}` : ""}`, { requires: ["paged_reads_v1"] }),
        { keepPreviousData: true, scope: `changes:${sessionId}` });
    const [err, setErr] = useState<string | null>(null);
    const [diff, setDiff] = useState<{ id: string; text: string } | null>(null);
    const [review, setReview] = useState<Review | null>(null);
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [busy, setBusy] = useState(false);
    const active = useRef(false);
    const diffRequest = useRef(0);
    const locked = disabled || busy || attempt !== null;
    const list = q.data?.items ?? [];
    if (list.length === 0 && cursors.length === 1) return <Panel data-testid="changes-panel" title="파일 변경 이력">
        <GroveText as="p" display="block" type="supporting" color={q.error ? "error" : "secondary"} role={q.error ? "alert" : "status"}>
            {q.loading ? "불러오는 중…" : q.error ? "파일 변경 이력을 읽지 못했습니다." : "변경 없음"}
        </GroveText>
    </Panel>;
    // 턴(요청)별로 묶는다. 사용자가 직접 만든 도구 요청은 turn_id가 없다.
    const byTurn = new Map<string | null, { turn: string | null; items: FileChange[] }>();
    for (const c of list) {
        const g = byTurn.get(c.turn_id);
        if (g) g.items.push(c);
        else byTurn.set(c.turn_id, { turn: c.turn_id, items: [c] });
    }
    const groups = [...byTurn.values()];
    const totals = new Map(q.data?.groups.map((g) => [g.turn_id, g]));
    const act = async (request: Attempt | { op: "undo" | "redo"; turn: string | null; through: number }) => {
        if (active.current || disabled) return;
        active.current = true;
        setBusy(true);
        setErr(null);
        try {
            const a: Attempt = "ids" in request ? request : {
                op: request.op, key: newKey(),
                ids: await api.get<string[]>(`/sessions/${sessionId}/file-changes/ids?through_seq=${request.through}&undone=${request.op === "redo"}${request.turn === null ? "" : `&turn_id=${encodeURIComponent(request.turn)}`}`, { requires: ["paged_reads_v1"] }),
            };
            if (a.ids.length === 0) return;
            setAttempt(a);
            await api.post(`/sessions/${sessionId}/file-changes/${a.op}`, { change_ids: a.ids }, { key: a.key });
            setAttempt(null);
            if (review) setReview(await api.get<Review>(`/sessions/${sessionId}/review`));
        } catch (e) {
            if (e instanceof ApiError && e.code === "conflict") {
                const files = ((e.details as { files?: { path: string }[] })?.files ?? []).map((f) => f.path).join(", ");
                setErr(`${e.message}${files ? ` (${files})` : ""}`);
            } else setErr(e instanceof ApiError ? e.message : "응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인하세요.");
            if (e instanceof ApiError && e.status < 500 && e.code !== "result_unknown" && !e.retryable) setAttempt(null);
        } finally {
            active.current = false;
            setBusy(false);
            q.reload();
        }
    };
    const showDiff = async (id: string) => {
        const current = ++diffRequest.current;
        if (diff?.id === id) return setDiff(null);
        // 최근 연 patch는 바로 보여 주고, 같은 시점에 서버에서 다시 받아 교체한다.
        const cached = changeDiffs.get(id);
        if (cached !== undefined) setDiff({ id, text: cached });
        const owner = authGeneration();
        try {
            const d = await api.get<{ diff: string | null; unavailable?: string }>(`/file-changes/${id}/diff`);
            const text = d.diff ?? (d.unavailable === "binary" ? "(텍스트가 아닌 파일)" : "(내용을 보관하지 않음)");
            changeDiffs.set(id, text, owner);
            if (current === diffRequest.current) setDiff({ id, text });
        } catch {
            // 다시 확인하지 못한 patch는 보관본을 최신처럼 남기지 않는다.
            changeDiffs.delete(id);
            if (current === diffRequest.current && cached !== undefined) setDiff(null);
        }
    };
    return (
        <Panel data-testid="changes-panel" title={<GroveStack as="span" direction="horizontal" align="center" gap={1.5}>
            파일 변경 이력 · {q.data?.applied ?? 0}/{q.data?.total ?? 0}
            <HelpTip label="파일 변경 복원 도움말"><SentenceText text="대화 되감기와 별개로 파일만 복원합니다. 기록 뒤 파일이 바뀌었으면 충돌로 알리고 아무것도 바꾸지 않습니다." /></HelpTip>
        </GroveStack>}>
            {err && (
                <GroveText as="p" display="block" type="inherit" color="error" role="alert">
                    {err}
                </GroveText>
            )}
            {q.error instanceof Error && <GroveText type="supporting" color="error" role="alert">{q.error.message}</GroveText>}
            {attempt && !busy && <GroveStack direction="horizontal" align="center" gap={1.5}>
                <ServerActionButton variant="secondary" density="compact" disabled={disabled} onClick={() => void act(attempt)}>같은 요청 결과 확인</ServerActionButton>
                <GroveButton variant="secondary" density="compact" onClick={() => { setAttempt(null); setErr(null); }}>원문 확인 후 닫기</GroveButton>
                <GroveText type="supporting" color="secondary">원문과 변경 이력을 확인한 뒤 새 요청을 시작하세요.</GroveText>
            </GroveStack>}
            {groups.map((g, gi) => {
                const total = totals.get(g.turn);
                return (
                    <GroveStack gap={1} paddingBlock={1} key={g.turn ?? `manual-${gi}`} data-testid="change-group">
                        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                            <GroveText type="supporting" weight="bold">{g.turn ? `요청 ${gi + 1}` : "직접 요청"}</GroveText>
                            <ServerActionButton variant="secondary" density="compact" disabled={locked || !total?.applied} onClick={() => void act({ op: "undo", turn: g.turn, through: q.data!.through_seq })}>
                                이 요청의 변경 되돌리기
                            </ServerActionButton>
                            <ServerActionButton variant="secondary" density="compact" disabled={locked || !total?.undone} onClick={() => void act({ op: "redo", turn: g.turn, through: q.data!.through_seq })}>
                                다시 적용
                            </ServerActionButton>
                        </GroveStack>
                        <GroveList density="compact" edge="flush" hasDividers>
                            {g.items.map((c) => (
                                <GroveListItem key={c.id} align="first-line" data-testid="change-row" data-state={c.undone_at ? "undone" : "applied"} label={<GroveStack gap={1} xstyle={gitPanelStyles.shrink}>
                                    <GroveText type="supporting" maxLines={1}><code title={c.path}>{c.path}</code></GroveText>
                                    <GroveText type="supporting" color="secondary">{OP[c.op] ?? c.op} · {c.tool}</GroveText>
                                    {c.undone_at && <GroveText type="supporting"> 되돌림</GroveText>}
                                    {!c.stored && <GroveText type="supporting"> (파일이 커서 되돌릴 수 없음)</GroveText>}
                                    {diff?.id === c.id && <CodeBlock data-testid="change-diff" code={diff.text} language="plaintext" isDiff isWrapped={false} />}
                                </GroveStack>} endContent={<GroveStack direction="horizontal" align="center" gap={2} xstyle={gitPanelStyles.actions}>
                                    <GroveButton variant="secondary" density="compact" onClick={() => void showDiff(c.id)}>patch</GroveButton>
                                    {c.op !== "deleted" && !c.undone_at && isArtifact(c.path) && <GroveButton variant="secondary" density="compact"
                                        title="변경 시점의 snapshot이 아니라 현재 파일을 엽니다"
                                        onClick={() => open({ kind: "file", project_id: projectId, resource_id: c.path, filePath: c.path, title: c.path }, "right")}>
                                        산출물 열기
                                    </GroveButton>}
                                    {c.stored && (
                                        <GroveButton variant="secondary" density="compact" disabled={locked} onClick={() => void act({ op: c.undone_at ? "redo" : "undo", ids: [c.id], key: newKey() })}>
                                            {c.undone_at ? "다시 적용" : "되돌리기"}
                                        </GroveButton>
                                    )}
                                </GroveStack>} />
                            ))}
                        </GroveList>
                    </GroveStack>
                );
            })}
            {(!!q.data?.next_before_seq || cursors.length > 1) && <GroveStack direction="horizontal" align="center" justify="end" gap={2}>
                <GroveText type="supporting" color="secondary">전체 {q.data?.total ?? 0}개 · {cursors.length}페이지</GroveText>
                <GroveButton type="button" variant="secondary" density="compact" aria-label="변경 이력 이전 페이지" disabled={cursors.length === 1 || q.loading}
                    onClick={() => setCursors((c) => c.slice(0, -1))}>이전</GroveButton>
                <GroveButton type="button" variant="secondary" density="compact" aria-label="변경 이력 다음 페이지" disabled={!q.data?.next_before_seq || q.loading}
                    onClick={() => setCursors((c) => [...c, q.data!.next_before_seq!])}>다음</GroveButton>
            </GroveStack>}
            <GroveButton variant="secondary" density="compact" onClick={() => void api.get<Review>(`/sessions/${sessionId}/review`).then(setReview)}>
                대화 전체 검토(처음 상태와 지금 비교)
            </GroveButton>
            {review && (
                <GroveStack gap={0} data-testid="review">
                    {review.files.map((f) => (
                        <GroveStack gap={0} key={f.path}>
                            <Code>{f.path}</Code> {f.unchanged && <GroveText type="supporting" color="secondary">처음과 같음</GroveText>}
                            {f.diff ? <CodeBlock code={f.diff} language="plaintext" isDiff isWrapped={false} /> : f.unavailable && <GroveText as="p" display="block" type="supporting" color="secondary">비교할 수 없음({f.unavailable})</GroveText>}
                        </GroveStack>
                    ))}
                </GroveStack>
            )}
        </Panel>
    );
}
