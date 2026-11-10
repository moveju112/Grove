import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";

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
    const list = tasks.data?.tasks ?? [];
    const running = list.filter((t) => t.status === "running");
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
        <details className="tasks" data-testid="tasks-panel" open={running.length > 0 || undefined}>
            <summary>
                백그라운드 작업 {running.length > 0 ? <strong>· 실행 중 {running.length}</strong> : list.length > 0 ? `· ${list.length}` : ""}
            </summary>
            <form
                className="inline"
                onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                        await api.post(`/sessions/${sessionId}/tasks`, { command: cmd });
                        setCmd("");
                    });
                }}
            >
                <input aria-label="백그라운드 명령" placeholder="명령(프로젝트 폴더에서 실행)" value={cmd} disabled={disabled} onChange={(e) => setCmd(e.target.value)} />
                <button type="submit" disabled={disabled || !cmd.trim()}>실행</button>
            </form>
            {err && <p className="err" role="alert">{err}</p>}
            <ul className="session-list">
                {list.slice(0, 20).map((t) => (
                    <li key={t.id} data-testid="task-row" data-status={t.status}>
                        <code className="small">{t.command}</code>
                        <span className={`status ${t.status}`}>
                            {LABEL[t.status]}
                            {t.exit_code !== null && t.status !== "completed" ? ` (코드 ${t.exit_code})` : ""}
                        </span>
                        <button className="ghost small" onClick={() => setView(view === t.id ? null : t.id)}>출력</button>
                        {t.status === "running" && (
                            <button className="ghost small" onClick={() => void act(() => api.post(`/tasks/${t.id}/cancel`))}>취소</button>
                        )}
                        {t.status === "unknown" && <span className="muted small" title={t.reason ?? ""}>프로세스가 남아 있을 수 있습니다</span>}
                        {view === t.id && <TaskOutput id={t.id} />}
                    </li>
                ))}
            </ul>
        </details>
    );
}

type Chunk = { data: string; next_offset: number; eof: boolean; stored_bytes: number; dropped_bytes: number };

function TaskOutput({ id }: { id: string }) {
    const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
    const [text, setText] = useState("");
    const [next, setNext] = useState(0);
    const [info, setInfo] = useState<Chunk | null>(null);
    const load = async (s: "stdout" | "stderr", offset: number, append: boolean) => {
        const c = await api.get<Chunk>(`/tasks/${id}/output?stream=${s}&offset=${offset}&limit=65536`);
        setText((t) => (append ? t + c.data : c.data));
        setNext(c.next_offset);
        setInfo(c);
    };
    useEffect(() => {
        void load("stdout", 0, false).catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
    return (
        <div className="task-output">
            <div className="inline">
                {(["stdout", "stderr"] as const).map((s) => (
                    <button key={s} className={stream === s ? "chip on" : "chip"} onClick={() => { setStream(s); void load(s, 0, false); }}>{s}</button>
                ))}
                <button className="ghost small" onClick={() => void load(stream, 0, false)}>새로고침</button>
            </div>
            <pre className="diff" data-testid="task-output">{text || "(출력 없음)"}</pre>
            {info && !info.eof && <button className="ghost small" onClick={() => void load(stream, next, true)}>더 보기</button>}
            {info && info.dropped_bytes > 0 && <p className="muted small">출력이 커서 앞부분 {info.stored_bytes}바이트만 보관했습니다({info.dropped_bytes}바이트 생략).</p>}
        </div>
    );
}
