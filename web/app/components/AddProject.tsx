import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { Project } from "../api/generated";

type Dirs = { path: string; parent: string | null; entries: { name: string; path: string }[]; truncated: boolean };

/// 프로젝트 추가(PROJECT-001): 서버 PC의 폴더를 둘러보거나 경로를 입력해 등록하고, 없으면 새 폴더로 만든다.
export function AddProjectDialog({ onDone, onClose }: { onDone: (p: Project) => void; onClose: () => void }) {
    const [path, setPath] = useState("");
    const [dirs, setDirs] = useState<Dirs | null>(null);
    const [hidden, setHidden] = useState(false);
    const [create, setCreate] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
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
    // 처음 열면 서버 사용자의 홈 폴더를 보여 준다. 숨김 표시를 바꾸면 같은 폴더를 다시 읽는다.
    useEffect(() => {
        void browse(dirs?.path, false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hidden]);

    const submit = async () => {
        if (!path.trim()) return;
        setBusy(true);
        setErr(null);
        try {
            onDone(await api.post<Project>("/projects", { root_path: path.trim(), create }));
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "프로젝트를 추가하지 못했습니다");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="dialog-backdrop" onClick={onClose}>
            <div className="dialog" role="dialog" aria-modal="true" aria-label="프로젝트 추가" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
                <h2>프로젝트 추가</h2>
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
                {err && (
                    <p className="err" role="alert">
                        {err}
                    </p>
                )}
                <div className="row">
                    <button disabled={busy || !path.trim()} onClick={() => void submit()}>
                        이 폴더를 프로젝트로 추가
                    </button>
                    <button className="ghost" onClick={onClose}>
                        취소
                    </button>
                </div>
            </div>
        </div>
    );
}
