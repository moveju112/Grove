import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { Project } from "../api/generated";
import { CreationDialog } from "./create/CreationDialog";
import { ProjectCreation } from "./create/creation";

type Dirs = { path: string; parent: string | null; entries: { name: string; path: string }[]; truncated: boolean };

/// 프로젝트 추가(PROJECT-001): 서버 PC의 폴더를 둘러보거나 경로를 입력해 등록하고, 없으면 새 폴더로 만든다.
export function AddProjectDialog({ onDone, onClose }: { onDone: (p: Project) => void; onClose: () => void }) {
    const [path, setPath] = useState("");
    const [dirs, setDirs] = useState<Dirs | null>(null);
    const [hidden, setHidden] = useState(false);
    const [create, setCreate] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [creation] = useState(() => new ProjectCreation());
    const done = useRef(onDone);
    done.current = onDone;
    const unresolved = creation.pending !== null;
    const close = () => { if (!creation.busy && !creation.pending) onClose(); };
    // 늦게 도착한 이전 요청의 응답이 최근 이동을 덮어쓰지 않게 마지막 요청만 반영한다.
    const seq = useRef(0);

    /// `fill`이 거짓이면 목록만 바꾸고 경로 칸은 건드리지 않는다(처음 열 때·숨김 전환).
    /// 사용자가 입력하는 도중에 응답이 와서 칸 내용이 바뀌는 일을 막는다.
    const browse = async (p?: string, fill = true) => {
        const my = ++seq.current;
        setErr(null);
        try {
            const q = new URLSearchParams();
            if (p) q.set("path", p);
            if (hidden) q.set("hidden", "true");
            const d = await api.get<Dirs>(`/fs/dirs?${q}`);
            if (my !== seq.current) return;
            setDirs(d);
            if (fill) setPath(d.path);
        } catch (e) {
            if (my !== seq.current) return;
            setErr(e instanceof ApiError ? e.message : "폴더를 읽지 못했습니다");
        }
    };
    // 경로 입력 제안(PROJECT-012): 입력이 멈추면 서버 PC의 맞는 폴더를 보인다. 늦은 응답은 버린다.
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const suggestSeq = useRef(0);
    useEffect(() => {
        const q = path.trim();
        const my = ++suggestSeq.current;
        if (!q || q === dirs?.path) { setSuggestions([]); return; }
        const t = setTimeout(() => {
            api.get<{ directories: string[] }>(`/fs/suggest?${new URLSearchParams({ q, limit: "8" })}`)
                .then((r) => { if (my === suggestSeq.current) setSuggestions(r.directories); })
                .catch(() => { if (my === suggestSeq.current) setSuggestions([]); });
        }, 250);
        return () => clearTimeout(t);
    }, [path, dirs?.path]);
    // 처음 열면 서버 사용자의 홈 폴더를 보여 준다. 숨김 표시를 바꾸면 같은 폴더를 다시 읽는다.
    useEffect(() => {
        void browse(dirs?.path, false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hidden]);

    const submit = async (endpoint: "/projects" | "/projects/clone", body: Record<string, unknown>) => {
        if (creation.busy) return;
        setBusy(true);
        setErr(null);
        try {
            const project = await creation.run(endpoint, body);
            if (project) done.current(project);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "프로젝트를 추가하지 못했습니다");
        } finally {
            setBusy(false);
        }
    };

    return (
        <CreationDialog label="프로젝트 추가" onClose={close} busy={busy}>
                <h2>프로젝트 추가</h2>
                {err && <p className="err" role="alert">{err}</p>}
                {busy && <p role="status">프로젝트 추가 중…</p>}
                {unresolved && !busy && <div className="warn" role="status">
                    생성 결과를 확인하지 못했습니다. 결과 확인 전에는 다른 생성 요청이나 닫기를 사용할 수 없습니다.
                    <button onClick={() => { const request = creation.pending!; void submit(request.path, request.body); }}>같은 생성 요청 결과 확인</button>
                </div>}
                <fieldset disabled={busy || unresolved} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                <label>
                    서버 PC의 폴더 경로
                    <input
                        value={path}
                        onChange={(e) => {
                            // 직접 입력하면 진행 중인 둘러보기 응답이 입력을 덮어쓰지 않는다.
                            seq.current++;
                            setPath(e.target.value);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && void browse(path)}
                        placeholder={dirs?.path ?? "/절대/경로"}
                        aria-label="폴더 경로"
                        autoFocus
                    />
                </label>
                {suggestions.length > 0 && (
                    <ul className="dir-list" aria-label="경로 제안">
                        {suggestions.map((s) => (
                            <li key={s}><button className="link small" onClick={() => { setSuggestions([]); void browse(s); }}>{s}</button></li>
                        ))}
                    </ul>
                )}
                <div className="row">
                    <button className="ghost small" onClick={() => void browse(path)}>이 경로 열기</button>
                    <button className="ghost small" disabled={!dirs?.parent} onClick={() => dirs?.parent && void browse(dirs.parent)}>
                        상위 폴더
                    </button>
                    <label className="small">
                        <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 숨김 폴더 표시
                    </label>
                </div>
                {dirs && (
                    <p className="muted small" data-testid="dir-current">
                        현재 위치: <code>{dirs.path}</code>
                    </p>
                )}
                {dirs && (
                    <ul className="dir-list" aria-label="하위 폴더">
                        {dirs.entries.length === 0 && <li className="muted small">하위 폴더 없음</li>}
                        {dirs.entries.map((d) => (
                            <li key={d.path}>
                                <button className="link" onClick={() => void browse(d.path)}>
                                    📁 {d.name}
                                </button>
                            </li>
                        ))}
                        {dirs.truncated && <li className="muted small">폴더가 많아 일부만 표시합니다. 경로를 직접 입력하세요</li>}
                    </ul>
                )}
                <label className="small">
                    <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} /> 폴더가 없으면 마지막 폴더를 새로 만들기
                </label>
                <div className="row">
                    <button disabled={!path.trim()} onClick={() => void submit("/projects", { root_path: path.trim(), create })}>
                        이 폴더를 프로젝트로 추가
                    </button>
                    <button className="ghost" onClick={close}>
                        취소
                    </button>
                </div>
                <details className="clone-repo">
                    <summary>저장소에서 clone</summary>
                    <CloneRepo target={dirs?.path ?? ""} onCreate={(body) => submit("/projects/clone", body)} />
                </details>
                </fieldset>
        </CreationDialog>
    );
}

type Repo = { full_name: string; name: string; description: string | null; private: boolean; url: string };
type Search = { status: "success" | "unavailable" | "unauthenticated" | "error"; repositories: Repo[]; error: string | null };

/// 저장소 clone(PROJECT-012): GitHub 저장소를 서버 PC의 gh로 찾거나 owner/name·원격 주소를 직접 입력해
/// 대상 폴더 아래 `<저장소 이름>`으로 받고 프로젝트로 등록한다. 응답을 받지 못하면 같은 키로만 다시 확인한다.
function CloneRepo({ target: initialTarget, onCreate }: { target: string; onCreate: (body: Record<string, unknown>) => Promise<void> }) {
    const [repo, setRepo] = useState("");
    const [protocol, setProtocol] = useState<"https" | "ssh">("https");
    const [target, setTarget] = useState(initialTarget);
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState<Search | null>(null);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => { if (!target && initialTarget) setTarget(initialTarget); }, [initialTarget]); // eslint-disable-line react-hooks/exhaustive-deps
    const slug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());

    const find = async () => {
        setErr(null);
        try {
            setSearch(await api.get<Search>(`/github/repos?${new URLSearchParams({ q: query.trim(), limit: "20" })}`));
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "저장소를 검색하지 못했습니다");
        }
    };
    const clone = async () => {
        const body = { repo: repo.trim(), target_directory: target.trim(), ...(slug ? { protocol } : {}) };
        await onCreate(body);
    };
    return <div className="stack" role="group" aria-label="저장소 clone">
        <div className="row">
            <input aria-label="GitHub 저장소 검색" placeholder="검색어(비우면 내 저장소)" value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void find()} />
            <button className="ghost small" onClick={() => void find()}>검색</button>
        </div>
        {search && search.status !== "success" && <p className="warn small" role="status">{search.error}</p>}
        {search?.status === "success" && (
            <ul className="dir-list" aria-label="저장소 검색 결과">
                {search.repositories.length === 0 && <li className="muted small">결과 없음</li>}
                {search.repositories.map((r) => (
                    <li key={r.full_name}>
                        <button className="link" onClick={() => setRepo(r.full_name)}>{r.full_name}{r.private ? " 🔒" : ""}</button>
                        {r.description && <span className="muted small"> {r.description}</span>}
                    </li>
                ))}
            </ul>
        )}
        <label>저장소(owner/name 또는 원격 주소)
            <input aria-label="clone할 저장소" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
        </label>
        {slug && <label className="small">clone 방식
            <select aria-label="clone 방식" value={protocol} onChange={(e) => setProtocol(e.target.value === "ssh" ? "ssh" : "https")}>
                <option value="https">https</option><option value="ssh">ssh</option>
            </select>
        </label>}
        <label>받을 상위 폴더
            <input aria-label="clone 대상 폴더" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/절대/경로 또는 ~/code" />
        </label>
        {err && <p className="err" role="alert">{err}</p>}
        <button disabled={!repo.trim() || !target.trim()} onClick={() => void clone()}>clone 후 프로젝트로 추가</button>
    </div>;
}
