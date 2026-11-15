import { HintText } from "../design/HintText";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "../design/CodeBlock";
import { StatusBadge } from "../design/StatusBadge";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import { Panel } from "./ui/Controls";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { TextInput } from "../design/Fields";

export type TaskRow = {
    id: string;
    command: string;
    cwd: string;
    status: "running" | "completed" | "failed" | "timeout" | "cancelled" | "unknown";
    exit_code: number | null;
    reason: string | null;
    stdout_bytes: number;
    stderr_bytes: number;
    started_at: string;
    ended_at: string | null;
    script?: { id: string; name: string; revision: number } | null;
};

const LABEL: Record<TaskRow["status"], string> = {
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    timeout: "시간 초과로 종료",
    cancelled: "취소됨",
    unknown: "결과 불명",
};

/// 세션의 백그라운드 작업: 시작·취소·출력 보기. 결과는 대화에도 note로 남는다.
export function TasksPanel({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
    const tasks = useQuery<{ tasks: TaskRow[] }>(`tasks:${sessionId}`, () => api.get(`/sessions/${sessionId}/tasks`));
    const [cmd, setCmd] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const [view, setView] = useState<string | null>(null);
    const [attempt, setAttempt] = useState<{ command: string; key: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const starting = useRef(false);
    const list = tasks.data?.tasks ?? [];
    const running = list.filter((t) => t.status === "running");
    const start = async () => {
        if (starting.current || disabled || !cmd.trim()) return;
        starting.current = true;
        setBusy(true);
        setErr(null);
        const a = attempt ?? { command: cmd, key: newKey() };
        setAttempt(a);
        try {
            await api.post(`/sessions/${sessionId}/tasks`, { command: a.command }, { key: a.key });
            setAttempt(null);
            setCmd("");
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인하세요.");
            // 응답 유실·서버 오류·영속 결과 불명은 새 키로 실행하지 않는다.
            if (e instanceof ApiError && e.status < 500 && e.code !== "result_unknown" && !e.retryable) setAttempt(null);
        } finally {
            starting.current = false;
            setBusy(false);
            tasks.reload();
        }
    };
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "작업 요청 실패");
        }
        tasks.reload();
    };
    return (
        <Panel data-testid="tasks-panel" title={<>
                백그라운드 작업 {running.length > 0 ? <strong>· 실행 중 {running.length}</strong> : list.length > 0 ? `· ${list.length}` : ""}
            </>}>
            <GroveStack as="form"
                gap={1.5} direction="horizontal" align="center"
                onSubmit={(e) => {
                    e.preventDefault();
                    void start();
                }}
            >
                <TextInput label="백그라운드 명령" isLabelHidden placeholder="명령을 입력하세요" value={cmd} isDisabled={disabled || busy || attempt !== null} onChange={setCmd} />
                <ServerActionButton type="submit" disabled={disabled || busy || attempt !== null || !cmd.trim()}>실행</ServerActionButton>
            </GroveStack>
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {attempt && !busy && <GroveStack direction="horizontal" align="center" gap={1.5}>
                <ServerActionButton variant="secondary" density="compact" disabled={disabled} onClick={() => void start()}>같은 요청 결과 확인</ServerActionButton>
                <GroveButton variant="secondary" density="compact" onClick={() => { setAttempt(null); setCmd(""); setErr(null); }}>다른 명령 입력</GroveButton>
                <GroveText type="supporting" color="secondary">기존 작업 상태는 아래 목록에서 확인하세요.</GroveText>
            </GroveStack>}
            <GroveList density="compact" edge="flush" hasDividers>
                {list.slice(0, 20).map((t) => (
                    <GroveListItem key={t.id} data-testid="task-row" data-status={t.status} label={<>
                        {t.script && <StatusBadge>script · {t.script.name} · r{t.script.revision}</StatusBadge>}
                        <Code>{t.command}</Code>
                        <GroveText type="supporting" color="secondary" data-testid="task-cwd">실행 위치: <code>{t.cwd}</code></GroveText>
                        <StatusBadge status={t.status}>
                            {LABEL[t.status]}
                            {t.exit_code !== null && t.status !== "completed" ? ` (코드 ${t.exit_code})` : ""}
                        </StatusBadge>
                        <GroveButton variant="secondary" density="compact" onClick={() => setView(view === t.id ? null : t.id)}>출력</GroveButton>
                        {t.status === "running" && (
                            <ServerActionButton variant="secondary" density="compact" onClick={() => void act(() => api.post(`/tasks/${t.id}/cancel`))}>취소</ServerActionButton>
                        )}
                        {t.status === "unknown" && <HintText type="supporting" color="secondary" hint={t.reason}>프로세스가 남아 있을 수 있습니다</HintText>}
                        {view === t.id && <TaskOutput id={t.id} />}
                    </>} />
                ))}
            </GroveList>
        </Panel>
    );
}

type Chunk = { data: string; next_offset: number; eof: boolean; stored_bytes: number; dropped_bytes: number };

function TaskOutput({ id }: { id: string }) {
    const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
    const [text, setText] = useState("");
    const [next, setNext] = useState(0);
    const [info, setInfo] = useState<Chunk | null>(null);
    const [error, setError] = useState<string | null>(null);
    const request = useRef(0);
    const load = async (s: "stdout" | "stderr", offset: number, append: boolean) => {
        const current = ++request.current;
        setError(null);
        if (!append) { setText(""); setInfo(null); }
        try {
            const c = await api.get<Chunk>(`/tasks/${id}/output?stream=${s}&offset=${offset}&limit=65536`);
            if (current !== request.current) return;
            setText((t) => (append ? t + c.data : c.data));
            setNext(c.next_offset);
            setInfo(c);
        } catch (e) {
            if (current !== request.current) return;
            const state = e instanceof ApiError ? (e.details as { state?: string } | undefined)?.state : undefined;
            setError(state === "expired" ? "보존 기간이 지나 로그가 삭제됐습니다."
                : state === "missing" ? "로그 원문이 없습니다."
                : e instanceof ApiError ? e.message : "작업 출력을 불러오지 못했습니다.");
        }
    };
    useEffect(() => {
        void load("stdout", 0, false);
        return () => { request.current++; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
    return (
        <GroveStack gap={0}>
            <GroveStack direction="horizontal" align="center" gap={1.5}>
                {(["stdout", "stderr"] as const).map((s) => (
                    <GroveButton key={s} appearance="choice" aria-pressed={stream === s} onClick={() => { setStream(s); void load(s, 0, false); }}>{s}</GroveButton>
                ))}
                <GroveButton variant="secondary" density="compact" onClick={() => void load(stream, 0, false)}>새로고침</GroveButton>
            </GroveStack>
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
            <CodeBlock data-testid="task-output" code={text || (error ? "" : "(출력 없음)")} />
            {info && !info.eof && <GroveButton variant="secondary" density="compact" onClick={() => void load(stream, next, true)}>더 보기</GroveButton>}
            {info && info.dropped_bytes > 0 && <GroveText as="p" display="block" type="supporting" color="secondary">출력이 커서 앞부분 {info.stored_bytes}바이트만 보관했습니다({info.dropped_bytes}바이트 생략).</GroveText>}
        </GroveStack>
    );
}
