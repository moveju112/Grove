import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionMenu } from "./ui/Controls";
import { ApiError, api, isLoggedIn, newKey } from "../api/client";
import { useQuery } from "../state/store";
import { fileAttemptKey, loadFileAttempt, loadFileBuffer, loadFileView, saveFileBuffer, saveFileView, type FileAttempt } from "../state/fileState";
import { watchFile, type FileContent as Content } from "../state/fileWatch";
import { usePaneVisible } from "../state/paneVisibility";
import { sha256Hex } from "../state/sha256";
import { ArtifactPreview } from "./ArtifactPreview";
import { isArtifact } from "../state/artifactPreview";
import { ExternalEditor } from "./files/ExternalEditor";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useServerBlockReason } from "./pwa/lifecycle";
import { connection, transportFetch } from "../api/transport";
import { Stack } from "@astryxdesign/core/Stack";

type Entry = { name: string; path: string; kind: "dir" | "file" | "link_outside" | "other"; size: number | null; mtime: string | null };
type Listing = { path: string; entries: Entry[]; truncated: boolean };

const enc = encodeURIComponent;

/// 서버 `files::MAX_UPLOAD`와 같은 값.
const MAX_UPLOAD = 5 * 1024 * 1024;

const COPY_ERROR ="이 기기에 편집 사본을 보관하지 못했습니다. 화면을 떠나기 전에 저장하거나 내용을 복사하세요.";
type AttemptCache = { key: string; restoreKey?: string; endpoint: string; method: FileAttempt["method"]; path?: string };

// 탐색기 작업과 편집기 저장은 응답 유실 뒤에도 요청 본문과 키를 함께 유지한다.
function useFileMutation<T>(onSuccess: (result: T, attempt: FileAttempt) => void, cache: AttemptCache) {
    const [attempt, setAttempt] = useState<FileAttempt | null>(() =>
        loadFileAttempt(localStorage, cache.key, cache.endpoint, cache.method, cache.path)
        ?? (cache.restoreKey ? loadFileAttempt(localStorage, cache.restoreKey, cache.endpoint, cache.method, cache.path) : null));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const active = useRef(false);
    // 기기 사본에 넣지 않는 큰 본문(업로드 원문). 같은 키로 다시 확인할 때만 메모리에서 함께 보낸다.
    const transient = useRef<{ key: string; body: Record<string, string> } | null>(null);
    useEffect(() => {
        if (!attempt || !isLoggedIn()) return;
        try { localStorage.setItem(cache.key, JSON.stringify(attempt)); }
        catch { setError(new ApiError(0, "local_copy_unavailable", "요청 사본을 보관하지 못했습니다. 기기 저장 공간을 확인하세요.", true)); }
    }, [cache.key]); // eslint-disable-line react-hooks/exhaustive-deps
    const clear = () => {
        localStorage.removeItem(cache.key);
        transient.current = null;
        setAttempt(null);
        setError(null);
    };
    const act = async (a: FileAttempt, extra?: Record<string, string>) => {
        if (active.current) return;
        active.current = true;
        if (extra) transient.current = { key: a.key, body: extra };
        const more = transient.current?.key === a.key ? transient.current.body : {};
        setAttempt(a);
        setBusy(true);
        setError(null);
        try {
            try { localStorage.setItem(cache.key, JSON.stringify(a)); }
            catch { throw new ApiError(0, "local_copy_unavailable", "요청 사본을 보관하지 못해 실행하지 않았습니다. 기기 저장 공간을 확인하세요.", true); }
            const result = await api[a.method]<T>(a.path, { ...a.body, ...more }, { key: a.key });
            clear();
            onSuccess(result, a);
        } catch (e) {
            setError(e);
            if (e instanceof ApiError && e.status < 500 && e.code !== "result_unknown" && !e.retryable) {
                localStorage.removeItem(cache.key);
                transient.current = null;
                setAttempt(null);
            }
        } finally {
            active.current = false;
            setBusy(false);
        }
    };
    return { attempt, busy, error, act, locked: busy || attempt !== null, clear };
}

function fileError(error: unknown): string {
    if (!(error instanceof ApiError)) return "응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인하세요.";
    const details = error.details as { staging?: string } | undefined;
    return error.message + (details?.staging ? ` (임시 복제본: ${details.staging})` : "");
}

/// 프로젝트 파일 탐색·편집. 저장은 연 시점의 sha256으로 외부 변경을 검사한다.
export function FilesView({ tabId, projectId, initial: start }: { tabId: string; projectId: string; initial?: { path: string; line?: number } | null }) {
    const serverBlocked = useServerBlockReason();
    const [openPath, setOpenPath] = useState<string | null>(() => start?.path ?? loadFileView(localStorage, projectId, tabId));
    const [dir, setDir] = useState(openPath?.includes("/") ? openPath.slice(0, openPath.lastIndexOf("/")).replace(/^new:/, "") : ".");
    const [copyError, setCopyError] = useState(false);
    const selectPath = (path: string) => {
        try { saveFileView(localStorage, projectId, tabId, path); setCopyError(false); }
        catch { setCopyError(true); }
        setOpenPath(path);
    };
    const [hidden, setHidden] = useState(false);
    const [sort, setSort] = useState("name");
    const [filter, setFilter] = useState("");
    const [editorLocked, setEditorLocked] = useState(false);
    const listing = useQuery<Listing>(`files:${projectId}:${dir}:${hidden}:${sort}`, () =>
        api.get(`/projects/${projectId}/files?path=${enc(dir)}&hidden=${hidden}&sort=${sort}`),
    );
    const mutation = useFileMutation<unknown>(() => listing.reload(), {
        key: fileAttemptKey(projectId, "", tabId, "op"), endpoint: `/projects/${projectId}/files/op`, method: "post",
    });
    const uploads = useFileMutation<unknown>(() => listing.reload(), {
        key: fileAttemptKey(projectId, "", tabId, "upload"), endpoint: `/projects/${projectId}/files/upload`, method: "post",
    });
    const locked = mutation.locked || uploads.locked || editorLocked;
    const op = (body: Record<string, string>) => {
        if (locked) return;
        void mutation.act({ method: "post", path: `/projects/${projectId}/files/op`, body, key: newKey() });
    };
    const uploadInput = useRef<HTMLInputElement>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    // 업로드(FILEUI-005): 기기 사본에는 경로·내용 hash만 남기고 원문은 메모리에만 둔다. 덮어쓰지 않는다.
    const upload = async (file: File) => {
        setUploadError(null);
        if (locked) return;
        if (file.size > MAX_UPLOAD) {
            setUploadError(`한 번에 올릴 수 있는 파일은 ${MAX_UPLOAD / 1024 / 1024}MiB까지입니다(${(file.size / 1024 / 1024).toFixed(1)}MiB).`);
            return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sha256 = await sha256Hex(bytes);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        void uploads.act({ method: "post", path: `/projects/${projectId}/files/upload`, body: { path: join(file.name), sha256 }, key: newKey() }, { data_base64: btoa(binary) });
    };
    const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
    const parent = dir === "." ? null : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
    const entries = (listing.data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
    return (
        <Stack direction="horizontal" className="files" data-testid="files-view">
            <aside className="file-tree">
                <div className="inline wrap">
                    <code className="small">{dir}</code>
                    {parent !== null && <button className="ghost small" disabled={locked} onClick={() => setDir(parent)}>상위 폴더</button>}
                </div>
                {Boolean(listing.error) && <div className="err" role="alert">
                    {listing.error instanceof ApiError ? listing.error.message : "폴더 목록을 불러오지 못했습니다."}
                    <button className="ghost small" onClick={listing.reload}>폴더 다시 확인</button>
                </div>}
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
                    <button className="ghost small" disabled={locked} onClick={() => { const n = prompt("새 파일 이름"); if (n) selectPath(`new:${join(n)}`); }}>새 파일</button>
                    <ServerActionButton className="ghost small" disabled={locked} onClick={() => { const n = prompt("새 폴더 이름"); if (n) void op({ op: "mkdir", path: join(n) }); }}>새 폴더</ServerActionButton>
                    <ServerActionButton className="ghost small" disabled={locked} onClick={() => uploadInput.current?.click()}>{uploads.busy ? "올리는 중…" : "파일 올리기"}</ServerActionButton>
                    <input ref={uploadInput} type="file" hidden aria-label="올릴 파일 선택" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
                </div>
                {uploadError && <p className="err" role="alert">{uploadError}</p>}
                {Boolean(uploads.error) && <p className="err" role="alert">{fileError(uploads.error)}</p>}
                {uploads.attempt && !uploads.busy && <div className="inline wrap">
                    <ServerActionButton className="ghost small" onClick={() => void uploads.act(uploads.attempt!)}>같은 업로드 결과 확인</ServerActionButton>
                    <button className="ghost small" onClick={() => { uploads.clear(); listing.reload(); }}>목록 확인 후 닫기</button>
                </div>}
                {Boolean(mutation.error) && <p className="err" role="alert">{fileError(mutation.error)}</p>}
                {mutation.attempt && !mutation.busy && <div className="inline wrap">
                    <ServerActionButton className="ghost small" onClick={() => void mutation.act(mutation.attempt!)}>같은 요청 결과 확인</ServerActionButton>
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
                                onClick={() => (e.kind === "dir" ? setDir(e.path) : selectPath(e.path))}
                            >
                                {e.kind === "dir" ? "📁 " : ""}{e.name}
                            </button>
                            <span className="muted small">{e.size !== null ? `${e.size}B` : ""}</span>
                            <ActionMenu className="row-menu" label={`${e.name} 작업`}>
                                <ServerActionButton className="ghost small" disabled={locked} onClick={() => { const to = prompt("새 이름(경로)", e.path); if (to && to !== e.path) void op({ op: "rename", path: e.path, to }); }}>이름 바꾸기</ServerActionButton>
                                <ServerActionButton className="ghost small" disabled={locked} onClick={() => { const to = prompt("복제본 경로", `${e.path}.copy`); if (to) void op({ op: "duplicate", path: e.path, to }); }}>복제</ServerActionButton>
                                <ServerActionButton
                                    className="ghost small danger"
                                    disabled={locked}
                                    onClick={() => {
                                        const c = prompt(`삭제하려면 경로를 그대로 입력하세요: ${e.path}\n(서버 휴지통으로 옮겨져 복구할 수 있습니다)`);
                                        if (c !== null) void op({ op: "delete", path: e.path, confirm: c });
                                    }}
                                >
                                    삭제
                                </ServerActionButton>
                            </ActionMenu>
                        </li>
                    ))}
                </ul>
                {listing.data?.truncated && <p className="muted small">항목이 많아 일부만 표시합니다. 이름 거르기를 쓰세요.</p>}
            </aside>
            <section className="file-pane">
                {copyError && <p className="err" role="alert">{COPY_ERROR}</p>}
                {openPath && !openPath.startsWith("new:") && <ExternalEditor key={`${projectId}:${openPath}`} projectId={projectId} path={openPath} disabled={locked} blockedReason={serverBlocked} />}
                {openPath ? <FileEditor key={openPath} copyId={tabId} projectId={projectId} path={openPath}
                    onSaved={() => { listing.reload(); if (openPath.startsWith("new:")) selectPath(openPath.slice(4)); }}
                    disabled={mutation.locked} onLock={setEditorLocked} line={openPath === start?.path ? start?.line : undefined} /> : <p className="muted">파일을 고르세요.</p>}
            </section>
        </Stack>
    );
}

function FileEditor({ copyId, projectId, path, onSaved, line, disabled, onLock }: { copyId: string; projectId: string; path: string; onSaved: () => void; line?: number; disabled: boolean; onLock: (locked: boolean) => void }) {
    const visible = usePaneVisible();
    const isNew = path.startsWith("new:");
    const real = isNew ? path.slice(4) : path;
    const [c, setC] = useState<Content | null>(null);
    const [saved] = useState(() => loadFileBuffer(localStorage, projectId, path, copyId));
    const [copyError, setCopyError] = useState(false);
    const area = useRef<HTMLTextAreaElement | null>(null);
    const refreshingPosition = useRef<{ start: number; end: number; direction: "forward" | "backward" | "none"; top: number; left: number } | null>(null);
    const jumped = useRef(false);
    useLayoutEffect(() => {
        // 명시적인 줄 이동이 저장 위치보다 우선한다. 편집 사본을 반영한 뒤 한 번만 복원한다.
        const el = area.current;
        if (!c || !el) return;
        const position = refreshingPosition.current;
        if (position) {
            el.setSelectionRange(position.start, position.end, position.direction);
            el.scrollTop = position.top;
            el.scrollLeft = position.left;
            refreshingPosition.current = null;
            return;
        }
        if (jumped.current) return;
        jumped.current = true;
        if (line) {
            const lines = el.value.split("\n");
            const at = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
            const end = at + (lines[line - 1]?.length ?? 0);
            el.focus();
            el.setSelectionRange(at, end);
            const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
            el.scrollTop = Math.max(0, (line - 3) * lh);
        } else if (saved) {
            const b = saved.buffer;
            el.setSelectionRange(b.start, b.end, b.direction);
            el.scrollTop = b.top;
            el.scrollLeft = b.left;
        }
    }, [c, line]);
    const [text, setText] = useState("");
    const [base, setBase] = useState<string | null>(null);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [watchError, setWatchError] = useState<string | null>(null);
    const [watchReady, setWatchReady] = useState(false);
    const mutation = useFileMutation<{ sha256: string }>((result, attempt) => {
        const saved = attempt.body.text ?? "";
        setBase(result.sha256);
        setC((current) => current ? { ...current, text: saved, sha256: result.sha256 } : current);
        setMsg({ kind: "ok", text: "저장됨" });
        onSaved();
    }, {
        key: fileAttemptKey(projectId, path, copyId),
        restoreKey: saved && saved.copy !== copyId ? fileAttemptKey(projectId, path, saved.copy) : undefined,
        endpoint: `/projects/${projectId}/files/content`, method: "put", path: real,
    });
    useEffect(() => { onLock(mutation.locked); }, [mutation.locked, onLock]);

    const load = async (restore = false) => {
        const draft = restore ? saved?.buffer : null;
        if (isNew) {
            setC({ path: real, size: 0, sha256: "", preview: "text", text: "" });
            setText(draft?.text ?? "");
            return;
        }
        const v = await api.get<Content>(`/projects/${projectId}/files/content?path=${enc(real)}`);
        setC(v);
        const hasDraft = draft?.text != null && draft.text !== v.text;
        setText(hasDraft ? draft.text! : v.text ?? "");
        setBase(hasDraft ? draft.base : v.sha256);
        setMsg(hasDraft ? {
            kind: draft.base === v.sha256 ? "ok" : "err",
            text: draft.base === v.sha256 ? "이 기기의 편집 사본을 복원했습니다. 파일은 아직 저장하지 않았습니다."
                : "파일이 바뀌었습니다. 복원한 편집은 보존했으며 이전 원문 기준으로 저장하므로 덮어쓰지 않습니다.",
        } : null);
        if (!restore) mutation.clear();
        void api.post("/recent/touch", { kind: "file", project_id: projectId, resource_id: real, title: real }).catch(() => undefined);
    };
    const loadFailed = (e: unknown) => setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "열기 실패" });
    useEffect(() => {
        load(true).catch(loadFailed);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);
    const receive = useRef<(content: Content) => void>(() => {});
    receive.current = (content) => {
        if (!c || c.sha256 === content.sha256) return;
        const keep = text !== (c.text ?? "") || mutation.locked;
        setC(content);
        if (keep) {
            setMsg({ kind: "err", text: "파일이 바뀌었습니다. 내 편집과 원래 저장 기준을 유지합니다. 최신 내용과 비교한 뒤 저장하세요." });
        } else {
            const el = area.current;
            if (el) refreshingPosition.current = {
                start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, top: el.scrollTop, left: el.scrollLeft,
            };
            setText(content.text ?? "");
            setBase(content.sha256);
            setMsg({ kind: "ok", text: "외부 변경을 반영했습니다." });
        }
    };
    useEffect(() => {
        setWatchReady(false);
        if (isNew || !c || !visible) return;
        return watchFile(projectId, c.path, {
            value: (content) => { setWatchReady(true); setWatchError(null); receive.current(content); },
            error: (error) => {
                setWatchReady(false);
                setWatchError(`파일 변경을 확인하지 못했습니다. 편집은 유지합니다. ${error instanceof ApiError ? error.message : "서버 연결을 확인하세요."}`);
            },
        });
    }, [projectId, c?.path, isNew, visible]); // eslint-disable-line react-hooks/exhaustive-deps
    // <img>·새 탭은 인증 헤더를 못 보내므로 5분짜리 파일 티켓을 받아 쓴다.
    const [ticket, setTicket] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const downloadUrl = useRef<string | null>(null);
    useEffect(() => () => { if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); }, []);
    const encrypted = !!connection();
    useEffect(() => {
        if (isNew || !c) return;
        const abort = new AbortController();
        let objectUrl: string | null = null;
        setTicket(null);
        setPreviewUrl(null);
        void api.post<{ url: string }>(`/projects/${projectId}/files/ticket`, { path: real }, { signal: abort.signal }).then(async (t) => {
            if (abort.signal.aborted) return;
            setTicket(t.url);
            if (encrypted && ["image", "svg", "pdf"].includes(c.preview)) {
                const response = await transportFetch(t.url, { signal: abort.signal });
                if (!response.ok) throw new Error("미리보기를 불러오지 못했습니다.");
                const blob = await response.blob();
                if (abort.signal.aborted) return;
                objectUrl = URL.createObjectURL(blob);
                setPreviewUrl(objectUrl);
            }
        }).catch(() => { if (!abort.signal.aborted) setTicket(null); });
        return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [c?.sha256]);
    const download = async () => {
        if (!ticket) return;
        try {
            const response = await transportFetch(`${ticket}?download=true`, { signal: AbortSignal.timeout(300_000) });
            if (!response.ok) throw new Error("파일을 내려받지 못했습니다.");
            const url = URL.createObjectURL(await response.blob());
            if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
            downloadUrl.current = url;
            const link = document.createElement("a");
            link.href = url;
            link.download = real.split("/").pop() ?? "download";
            link.click();
        } catch { setMsg({ kind: "err", text: "파일을 내려받지 못했습니다. 다시 시도하세요." }); }
    };
    const dirty = c?.text !== null && c !== null && text !== (c.text ?? "");
    const capture = (value = text) => {
        const el = area.current;
        if (!c || c.text === null || !el || !isLoggedIn()) return;
        try {
            saveFileBuffer(localStorage, projectId, path, copyId, {
                text: value === c.text ? null : value, base,
                start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection,
                top: el.scrollTop, left: el.scrollLeft,
            });
            setCopyError(false);
        } catch { setCopyError(true); }
    };
    useEffect(() => { capture(); }, [text, base, c]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!dirty) return;
        const h = (e: BeforeUnloadEvent) => e.preventDefault();
        window.addEventListener("beforeunload", h);
        return () => window.removeEventListener("beforeunload", h);
    }, [dirty]);
    if (!c) return msg ? <div className="editor" data-testid="file-editor">
        <h2><code>{real}</code></h2>
        <p className="err" role="alert">파일을 열 수 없습니다: {msg.text}</p>
        {saved?.buffer.text != null && <>
            <p className="warn small">이 기기의 저장 전 편집 사본입니다. 원문이 아니며 복사해서 보관할 수 있습니다.</p>
            <textarea className="code" aria-label="복구용 편집 사본" value={saved.buffer.text} readOnly spellCheck={false} />
        </>}
        <button className="ghost small" onClick={() => void load(true).catch(loadFailed)}>파일 다시 확인</button>
    </div> : <p className="muted">여는 중…</p>;
    const raw = encrypted ? previewUrl : ticket;
    const save = () => {
        if (disabled || mutation.locked) return;
        setMsg(null);
        void mutation.act({ method: "put", path: `/projects/${projectId}/files/content`, body: { path: real, expected_sha256: base, text }, key: newKey() });
    };
    const conflict = (dirty && !isNew && base !== c.sha256)
        || (mutation.error instanceof ApiError && ["file_changed", "file_missing", "already_exists"].includes(mutation.error.code));
    return (
        <div className="editor" data-testid="file-editor">
            <h2 className="inline">
                <code>{real}</code> {dirty && <strong className="dirty" title="저장 안 됨">● 저장 안 됨</strong>}
                {!isNew && <span className="muted small" data-testid="file-watch-status">
                    {!visible ? "변경 확인 일시정지" : watchError ? "변경 확인 대기" : watchReady ? "자동 확인 · 5초" : "변경 확인 중"}
                </span>}
                {encrypted ? ticket && <button className="small ghost" onClick={() => void download()}>내려받기</button>
                    : raw && <a className="small" href={`${raw}?download=true`} download>내려받기</a>}
            </h2>
            {c.preview === "image" || (c.preview === "svg" && c.text === null) ? (
                raw ? <img className="preview" src={raw} alt={real} /> : <p className="muted">불러오는 중…</p>
            ) : c.preview === "pdf" ? (
                raw && <a href={raw} target="_blank" rel="noopener noreferrer">PDF를 새 탭에서 열기</a>
            ) : c.text === null ? (
                <p className="muted">{c.reason === "too_large" ? "파일이 커서 편집기로 열 수 없습니다. 내려받아 확인하세요." : "텍스트가 아닌 파일입니다."}</p>
            ) : (
                <>
                    <textarea ref={area} className="code" aria-label="파일 내용" spellCheck={false} readOnly={mutation.locked || disabled} value={text}
                        onChange={(e) => { setText(e.target.value); capture(e.target.value); }}
                        onSelect={() => capture()} onScroll={() => capture()} onBlur={() => capture()} />
                    <div className="inline">
                        <ServerActionButton disabled={disabled || mutation.locked || (!dirty && !isNew)} onClick={() => void save()}>저장</ServerActionButton>
                        {conflict && <button className="ghost" onClick={() => { if (confirm("내 편집을 버리고 최신 내용을 불러올까요?")) void load(); }}>최신 내용 불러오기</button>}
                    </div>
                    {isArtifact(real) && <ArtifactPreview path={real} text={text} dirty={dirty} />}
                </>
            )}
            {copyError && <p className="err" role="alert">{COPY_ERROR}</p>}
            {mutation.attempt && !mutation.busy && <div className="inline wrap">
                <ServerActionButton className="ghost small" onClick={() => void mutation.act(mutation.attempt!)}>같은 요청 결과 확인</ServerActionButton>
                <button className="ghost small" onClick={() => mutation.clear()}>원문 확인 후 닫기</button>
                <span className="muted small">입력은 유지합니다. 원문을 확인한 뒤 다음 저장을 시작하세요.</span>
            </div>}
            {Boolean(mutation.error) && <p className="save-state error" role="status">{fileError(mutation.error)}</p>}
            {!mutation.error && watchError && <p className="save-state error" role="status">{watchError}</p>}
            {!mutation.error && !watchError && msg && <p className={msg.kind === "ok" ? "save-state" : "save-state error"} role="status">{msg.text}</p>}
        </div>
    );
}
