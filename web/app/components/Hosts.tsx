import { useEffect, useRef, useState } from "react";
import { When } from "./When";
import { createPortal } from "react-dom";
import { HOSTS_KEY, insecureRemote, loadHosts, markHostOpened, recentHosts, removeHost, saveHost, type Host } from "../state/hosts";

/// 호스트별 페이지를 별도 탭으로 열어 요청·stream·메모리 상태를 섞지 않는다.
export function Hosts() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" className="ghost host-picker" onClick={() => setOpen(true)} title={`현재 호스트: ${location.origin}`} aria-label={`호스트 선택: ${location.origin}`}>
                호스트 · {location.host}
            </button>
            {open && createPortal(<HostsDialog onClose={() => setOpen(false)} />, document.body)}
        </>
    );
}

function HostsDialog({ onClose }: { onClose: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [hosts, setHosts] = useState(() => loadHosts(localStorage));
    const [editing, setEditing] = useState<string | undefined>();
    const [alias, setAlias] = useState("");
    const [address, setAddress] = useState("");
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        dialog.current!.showModal();
        const changed = (e: StorageEvent) => {
            if (e.key === HOSTS_KEY || e.key === null) setHosts(loadHosts(localStorage));
        };
        window.addEventListener("storage", changed);
        return () => window.removeEventListener("storage", changed);
    }, []);

    const reset = () => {
        setEditing(undefined);
        setAlias("");
        setAddress("");
        setError(null);
    };
    const edit = (host: Host) => {
        setEditing(host.origin);
        setAlias(host.alias);
        setAddress(host.origin);
        setError(null);
    };
    const change = (operation: () => Host[]) => {
        try {
            setHosts(operation());
            setError(null);
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : "호스트 목록을 저장하지 못했습니다.");
            return false;
        }
    };
    const close = () => {
        // 먼저 native dialog를 닫아 focus를 호출 버튼으로 돌린 뒤 portal을 해제한다.
        dialog.current!.close();
        onClose();
    };
    return (
        <dialog ref={dialog} className="dialog host-dialog" aria-label="호스트 관리" onCancel={(e) => { e.preventDefault(); close(); }}>
            <h2>호스트</h2>
            <p className="small">현재 호스트: <strong className="host-address">{location.origin}</strong></p>
            <p className="muted small">목록은 이 브라우저의 현재 origin에만 저장합니다. 다른 호스트는 독립된 새 탭에서 열고 그 서버에서 로그인합니다. 토큰·초안·승인·파일을 다른 호스트로 전달하지 않습니다.</p>
            <ul className="host-list" aria-label="등록한 호스트">
                {recentHosts(hosts).map((host) => (
                    <li key={host.origin} data-testid="host-row">
                        <strong>{host.alias}</strong>
                        <code className="host-address">{host.origin}</code>
                        {host.origin === location.origin && <span className="small">현재 호스트</span>}
                        <span className="muted small">
                            {host.lastOpenedAt === null ? "아직 열지 않음" : <>최근 열기: <When at={new Date(host.lastOpenedAt).toISOString()} /></>}
                            {" · 연결 성공 여부가 아닌 열기 기록"}
                        </span>
                        {insecureRemote(host.origin) && <p className="warn small">암호화되지 않은 HTTP입니다. 토큰과 대화가 노출될 수 있으니 HTTPS 또는 신뢰하는 VPN을 사용하세요.</p>}
                        <div className="row">
                            <a href={host.origin + "/"} target="_blank" rel="noopener noreferrer" onClick={(e) => {
                                if (!change(() => markHostOpened(localStorage, host.origin))) e.preventDefault();
                            }}>새 탭에서 열기</a>
                            <button type="button" className="ghost small" onClick={() => edit(host)}>수정</button>
                            <button type="button" className="ghost small" onClick={() => {
                                if (change(() => removeHost(localStorage, host.origin)) && editing === host.origin) reset();
                            }}>삭제</button>
                        </div>
                    </li>
                ))}
            </ul>
            {hosts.length === 0 && <p className="muted">등록한 호스트가 없습니다.</p>}
            <form aria-label={editing ? "호스트 수정" : "호스트 추가"} onSubmit={(e) => {
                e.preventDefault();
                if (change(() => saveHost(localStorage, address, alias, editing))) reset();
            }}>
                <label>별명<input value={alias} maxLength={80} required onChange={(e) => setAlias(e.target.value)} autoComplete="off" /></label>
                <label>서버 주소<input type="url" value={address} required onChange={(e) => setAddress(e.target.value)} placeholder="https://grove.example.com" autoComplete="off" spellCheck={false} /></label>
                <p className="muted small">서버 주소만 입력하세요. 비밀번호·토큰·페어링 링크는 넣지 마세요.</p>
                <div className="row">
                    <button type="submit">{editing ? "변경 저장" : "호스트 추가"}</button>
                    {editing && <button type="button" className="ghost" onClick={reset}>수정 취소</button>}
                </div>
            </form>
            {error && <p className="err" role="alert">{error}</p>}
            <button type="button" className="ghost" onClick={close}>닫기</button>
        </dialog>
    );
}
