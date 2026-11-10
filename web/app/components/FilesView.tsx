import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";

type Entry = { name: string; path: string; kind: "dir" | "file" | "link_outside" | "other"; size: number | null; mtime: string | null };
type Listing = { path: string; entries: Entry[]; truncated: boolean };
type Content = { path: string; size: number; sha256: string; preview: "text" | "image" | "svg" | "pdf" | "html"; text: string | null; reason?: string };

const enc = encodeURIComponent;

/// 프로젝트 파일 탐색·편집. 저장은 연 시점의 sha256으로 외부 변경을 검사한다.
export function FilesView({ projectId, initial }: { projectId: string; initial?: string | null }) {
    // 처음 열 파일(탭의 resource_id = "경로" 또는 "경로:줄")
    const start = parseInitial(initial);
    const [dir, setDir] = useState(start ? (start.path.includes("/") ? start.path.slice(0, start.path.lastIndexOf("/")) : ".") : ".");
    const [hidden, setHidden] = useState(false);
    const [sort, setSort] = useState("name");
    const [filter, setFilter] = useState("");
    const [openPath, setOpenPath] = useState<string | null>(start?.path ?? null);
    const [err, setErr] = useState<string | null>(null);
    const listing = useQuery<Listing>(`files:${projectId}:${dir}:${hidden}:${sort}`, () =>
        api.get(`/projects/${projectId}/files?path=${enc(dir)}&hidden=${hidden}&sort=${sort}`),
    );
    const op = async (body: Record<string, string>) => {
        setErr(null);
        try {
            await api.post(`/projects/${projectId}/files/op`, body);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "작업 실패");
        }
        listing.reload();
    };
    const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
    const parent = dir === "." ? null : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
    const entries = (listing.data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
    return (
        <div className="files" data-testid="files-view">
            <aside className="file-tree">
                <div className="inline wrap">
                    <code className="small">{dir}</code>
                    {parent !== null && <button className="ghost small" onClick={() => setDir(parent)}>상위 폴더</button>}
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
                    <button className="ghost small" onClick={() => { const n = prompt("새 파일 이름"); if (n) setOpenPath(`new:${join(n)}`); }}>새 파일</button>
                    <button className="ghost small" onClick={() => { const n = prompt("새 폴더 이름"); if (n) void op({ op: "mkdir", path: join(n) }); }}>새 폴더</button>
                </div>
                {err && <p className="err" role="alert">{err}</p>}
                <ul className="session-list">
                    {entries.map((e) => (
                        <li key={e.path}>
                            <button
                                className="link"
                                disabled={e.kind === "link_outside" || e.kind === "other"}
                                title={e.kind === "link_outside" ? "프로젝트 밖을 가리키는 링크" : undefined}
                                onClick={() => (e.kind === "dir" ? setDir(e.path) : setOpenPath(e.path))}
                            >
                                {e.kind === "dir" ? "📁 " : ""}{e.name}
                            </button>
                            <span className="muted small">{e.size !== null ? `${e.size}B` : ""}</span>
                            <details className="row-menu">
                                <summary aria-label={`${e.name} 작업`}>⋯</summary>
                                <button className="ghost small" onClick={() => { const to = prompt("새 이름(경로)", e.path); if (to && to !== e.path) void op({ op: "rename", path: e.path, to }); }}>이름 바꾸기</button>
                                <button className="ghost small" onClick={() => { const to = prompt("복제본 경로", `${e.path}.copy`); if (to) void op({ op: "duplicate", path: e.path, to }); }}>복제</button>
                                <button
                                    className="ghost small danger"
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
                {openPath ? <FileEditor key={openPath} projectId={projectId} path={openPath} onSaved={listing.reload} line={openPath === start?.path ? start?.line : undefined} /> : <p className="muted">파일을 고르세요.</p>}
            </section>
        </div>
    );
}

function parseInitial(s?: string | null): { path: string; line?: number } | null {
    if (!s) return null;
    const m = s.match(/^(.*?)(?::(\d+))?$/);
    return m && m[1] ? { path: m[1], line: m[2] ? Number(m[2]) : undefined } : null;
}

function FileEditor({ projectId, path, onSaved, line }: { projectId: string; path: string; onSaved: () => void; line?: number }) {
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
    const [msg, setMsg] = useState<{ kind: "ok" | "err" | "conflict"; text: string } | null>(null);
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
    const save = async () => {
        try {
            const r = await api.put<{ sha256: string }>(`/projects/${projectId}/files/content`, { path: real, expected_sha256: base, text });
            setBase(r.sha256);
            setC({ ...c, text, sha256: r.sha256 });
            setMsg({ kind: "ok", text: "저장됨" });
            onSaved();
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) setMsg({ kind: "conflict", text: "열어 둔 뒤 파일이 바뀌었습니다. 내 편집은 그대로 있으니 최신 내용을 불러와 비교하세요." });
            else setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "저장 실패" });
        }
    };
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
                    <textarea ref={area} className="code" aria-label="파일 내용" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
                    <div className="inline">
                        <button disabled={!dirty && !isNew} onClick={() => void save()}>저장</button>
                        {msg?.kind === "conflict" && <button className="ghost" onClick={() => { if (confirm("내 편집을 버리고 최신 내용을 불러올까요?")) void load(); }}>최신 내용 불러오기</button>}
                    </div>
                </>
            )}
            {msg && <p className={msg.kind === "ok" ? "save-state" : "save-state error"} role="status">{msg.text}</p>}
        </div>
    );
}
