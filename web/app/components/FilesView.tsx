import { useEffect, useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";

type Entry = { name: string; path: string; kind: "dir" | "file" | "link_outside" | "other"; size: number | null; mtime: string | null };
type Listing = { path: string; entries: Entry[]; truncated: boolean };
type Content = { path: string; size: number; sha256: string; preview: "text" | "image" | "svg" | "pdf" | "html"; text: string | null; reason?: string };

const enc = encodeURIComponent;

type FileAttempt = { method: "post" | "put"; path: string; body: Record<string, string | null>; key: string };

// 탐색기 작업과 편집기 저장은 응답 유실 뒤에도 요청 본문과 키를 함께 유지한다.
function useFileMutation<T>(onSuccess: (result: T, attempt: FileAttempt) => void) {
    const [attempt, setAttempt] = useState<FileAttempt | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const active = useRef(false);
    const act = async (a: FileAttempt) => {
        if (active.current) return;
        active.current = true;
        setAttempt(a);
        setBusy(true);
        setError(null);
        try {
            const result = await api[a.method]<T>(a.path, a.body, { key: a.key });
            setAttempt(null);
            onSuccess(result, a);
        } catch (e) {
            setError(e);
            if (e instanceof ApiError && e.status < 500 && e.code !== "result_unknown" && !e.retryable) setAttempt(null);
        } finally {
            active.current = false;
            setBusy(false);
        }
    };
    return { attempt, busy, error, act, locked: busy || attempt !== null, clear: () => { setAttempt(null); setError(null); } };
}

function fileError(error: unknown): string {
    if (!(error instanceof ApiError)) return "응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인하세요.";
    const details = error.details as { staging?: string } | undefined;
    return error.message + (details?.staging ? ` (임시 복제본: ${details.staging})` : "");
}

/// 프로젝트 파일 탐색·편집. 저장은 연 시점의 sha256으로 외부 변경을 검사한다.
export function FilesView({ projectId, initial }: { projectId: string; initial?: string | null }) {
    // 처음 열 파일(탭의 resource_id = "경로" 또는 "경로:줄")
    const start = parseInitial(initial);
    const [dir, setDir] = useState(start ? (start.path.includes("/") ? start.path.slice(0, start.path.lastIndexOf("/")) : ".") : ".");
    const [hidden, setHidden] = useState(false);
    const [sort, setSort] = useState("name");
    const [filter, setFilter] = useState("");
    const [openPath, setOpenPath] = useState<string | null>(start?.path ?? null);
    const [editorLocked, setEditorLocked] = useState(false);
    const listing = useQuery<Listing>(`files:${projectId}:${dir}:${hidden}:${sort}`, () =>
        api.get(`/projects/${projectId}/files?path=${enc(dir)}&hidden=${hidden}&sort=${sort}`),
    );
    const mutation = useFileMutation<unknown>(() => listing.reload());
    const locked = mutation.locked || editorLocked;
    const op = (body: Record<string, string>) => {
        if (locked) return;
        void mutation.act({ method: "post", path: `/projects/${projectId}/files/op`, body, key: newKey() });
    };
    const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
    const parent = dir === "." ? null : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
    const entries = (listing.data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
    return (
        <div className="files" data-testid="files-view">
            <aside className="file-tree">
                <div className="inline wrap">
                    <code className="small">{dir}</code>
                    {parent !== null && <button className="ghost small" disabled={locked} onClick={() => setDir(parent)}>상위 폴더</button>}
                </div>
                <div className="inline wrap">
                    <input type="search" aria-label="파일 이름 거르기" placeholder="이름 거르기" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <select aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value)}>
                        <option value="name">이름</option>
                        <option value="mtime">수정 시각</option>
                        <option value="size">크기</option>
                    </select>
                    <label className="check small"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 숨김 파일</label>
                </div>
                <div className="inline wrap">
                    <button className="ghost small" disabled={locked} onClick={() => { const n = prompt("새 파일 이름"); if (n) setOpenPath(`new:${join(n)}`); }}>새 파일</button>
                    <button className="ghost small" disabled={locked} onClick={() => { const n = prompt("새 폴더 이름"); if (n) void op({ op: "mkdir", path: join(n) }); }}>새 폴더</button>
                </div>
                {Boolean(mutation.error) && <p className="err" role="alert">{fileError(mutation.error)}</p>}
                {mutation.attempt && !mutation.busy && <div className="inline wrap">
                    <button className="ghost small" onClick={() => void mutation.act(mutation.attempt!)}>같은 요청 결과 확인</button>
                    <button className="ghost small" onClick={() => { mutation.clear(); listing.reload(); }}>원문 확인 후 닫기</button>
                    <span className="muted small">원문과 대상 경로를 확인한 뒤 새 작업을 시작하세요.</span>
                </div>}
                <ul className="session-list">
                    {entries.map((e) => (
                        <li key={e.path}>
                            <button
                                className="link"
                                disabled={locked || e.kind === "link_outside" || e.kind === "other"}
                                title={e.kind === "link_outside" ? "프로젝트 밖을 가리키는 링크" : undefined}
                                onClick={() => (e.kind === "dir" ? setDir(e.path) : setOpenPath(e.path))}
                            >
                                {e.kind === "dir" ? "📁 " : ""}{e.name}
                            </button>
                            <span className="muted small">{e.size !== null ? `${e.size}B` : ""}</span>
                            <details className="row-menu">
                                <summary aria-label={`${e.name} 작업`}>⋯</summary>
                                <button className="ghost small" disabled={locked} onClick={() => { const to = prompt("새 이름(경로)", e.path); if (to && to !== e.path) void op({ op: "rename", path: e.path, to }); }}>이름 바꾸기</button>
                                <button className="ghost small" disabled={locked} onClick={() => { const to = prompt("복제본 경로", `${e.path}.copy`); if (to) void op({ op: "duplicate", path: e.path, to }); }}>복제</button>
                                <button
                                    className="ghost small danger"
                                    disabled={locked}
                                    onClick={() => {
                                        const c = prompt(`삭제하려면 경로를 그대로 입력하세요: ${e.path}\n(서버 휴지통으로 옮겨져 복구할 수 있습니다)`);
                                        if (c !== null) void op({ op: "delete", path: e.path, confirm: c });
                                    }}
                                >
                                    삭제
                                </button>
                            </details>
                        </li>
                    ))}
                </ul>
                {listing.data?.truncated && <p className="muted small">항목이 많아 일부만 표시합니다. 이름 거르기를 쓰세요.</p>}
            </aside>
            <section className="file-pane">
                {openPath ? <FileEditor key={openPath} projectId={projectId} path={openPath} onSaved={listing.reload} disabled={mutation.locked} onLock={setEditorLocked} line={openPath === start?.path ? start?.line : undefined} /> : <p className="muted">파일을 고르세요.</p>}
            </section>
        </div>
    );
}

function parseInitial(s?: string | null): { path: string; line?: number } | null {
    if (!s) return null;
    const m = s.match(/^(.*?)(?::(\d+))?$/);
    return m && m[1] ? { path: m[1], line: m[2] ? Number(m[2]) : undefined } : null;
}

function FileEditor({ projectId, path, onSaved, line, disabled, onLock }: { projectId: string; path: string; onSaved: () => void; line?: number; disabled: boolean; onLock: (locked: boolean) => void }) {
    const isNew = path.startsWith("new:");
    const real = isNew ? path.slice(4) : path;
    const [c, setC] = useState<Content | null>(null);
    const area = useRef<HTMLTextAreaElement | null>(null);
    const jumped = useRef(false);
    useEffect(() => {
        // 지정한 줄을 선택하고 그 위치로 스크롤한다(한 번만).
        const el = area.current;
        if (!line || !c || jumped.current || !el) return;
        jumped.current = true;
        const lines = (c.text ?? "").split("\n");
        const at = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
        const end = at + (lines[line - 1]?.length ?? 0);
        el.focus();
        el.setSelectionRange(at, end);
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
        el.scrollTop = Math.max(0, (line - 3) * lh);
    }, [c, line]);
    const [text, setText] = useState("");
    const [base, setBase] = useState<string | null>(null);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const mutation = useFileMutation<{ sha256: string }>((result, attempt) => {
        const saved = attempt.body.text ?? "";
        setBase(result.sha256);
        setC((current) => current ? { ...current, text: saved, sha256: result.sha256 } : current);
        setMsg({ kind: "ok", text: "저장됨" });
        onSaved();
    });
    useEffect(() => { onLock(mutation.locked); }, [mutation.locked, onLock]);

    const load = async () => {
        if (isNew) {
            setC({ path: real, size: 0, sha256: "", preview: "text", text: "" });
            return;
        }
        const v = await api.get<Content>(`/projects/${projectId}/files/content?path=${enc(real)}`);
        setC(v);
        setText(v.text ?? "");
        setBase(v.sha256);
        setMsg(null);
        mutation.clear();
    };
    useEffect(() => {
        load().catch((e) => setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "열기 실패" }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);
    // <img>·새 탭은 인증 헤더를 못 보내므로 5분짜리 파일 티켓을 받아 쓴다.
    const [ticket, setTicket] = useState<string | null>(null);
    useEffect(() => {
        if (isNew || !c) return;
        api.post<{ url: string }>(`/projects/${projectId}/files/ticket`, { path: real }).then((t) => setTicket(t.url), () => setTicket(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [c?.sha256]);
    const dirty = c?.text !== null && c !== null && text !== (c.text ?? "");
    useEffect(() => {
        if (!dirty) return;
        const h = (e: BeforeUnloadEvent) => e.preventDefault();
        window.addEventListener("beforeunload", h);
        return () => window.removeEventListener("beforeunload", h);
    }, [dirty]);
    if (!c) return msg ? <p className="err">{msg.text}</p> : <p className="muted">여는 중…</p>;
    const raw = ticket;
    const save = () => {
        if (disabled || mutation.locked) return;
        setMsg(null);
        void mutation.act({ method: "put", path: `/projects/${projectId}/files/content`, body: { path: real, expected_sha256: base, text }, key: newKey() });
    };
    const conflict = mutation.error instanceof ApiError && ["file_changed", "file_missing", "already_exists"].includes(mutation.error.code);
    return (
        <div className="editor" data-testid="file-editor">
            <h2 className="inline">
                <code>{real}</code> {dirty && <strong className="dirty" title="저장 안 됨">● 저장 안 됨</strong>}
                {raw && <a className="small" href={`${raw}?download=true`} download>내려받기</a>}
            </h2>
            {c.preview === "image" || c.preview === "svg" ? (
                raw ? <img className="preview" src={raw} alt={real} /> : <p className="muted">불러오는 중…</p>
            ) : c.preview === "pdf" ? (
                raw && <a href={raw} target="_blank" rel="noopener noreferrer">PDF를 새 탭에서 열기</a>
            ) : c.text === null ? (
                <p className="muted">{c.reason === "too_large" ? "파일이 커서 편집기로 열 수 없습니다. 내려받아 확인하세요." : "텍스트가 아닌 파일입니다."}</p>
            ) : (
                <>
                    <textarea ref={area} className="code" aria-label="파일 내용" spellCheck={false} readOnly={mutation.locked || disabled} value={text} onChange={(e) => setText(e.target.value)} />
                    <div className="inline">
                        <button disabled={disabled || mutation.locked || (!dirty && !isNew)} onClick={() => void save()}>저장</button>
                        {conflict && <button className="ghost" onClick={() => { if (confirm("내 편집을 버리고 최신 내용을 불러올까요?")) void load(); }}>최신 내용 불러오기</button>}
                    </div>
                </>
            )}
            {mutation.attempt && !mutation.busy && <div className="inline wrap">
                <button className="ghost small" onClick={() => void mutation.act(mutation.attempt!)}>같은 요청 결과 확인</button>
                <button className="ghost small" onClick={() => mutation.clear()}>원문 확인 후 닫기</button>
                <span className="muted small">입력은 유지합니다. 원문을 확인한 뒤 다음 저장을 시작하세요.</span>
            </div>}
            {Boolean(mutation.error) && <p className="save-state error" role="status">{fileError(mutation.error)}</p>}
            {!mutation.error && msg && <p className={msg.kind === "ok" ? "save-state" : "save-state error"} role="status">{msg.text}</p>}
        </div>
    );
}
