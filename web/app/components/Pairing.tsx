import { useEffect, useRef, useState } from "react";
import { When } from "./When";
import { ApiError, api, isLoggedIn, redeemPairing, requestPairing, type PendingPairing } from "../api/client";
import type { PairingInfo } from "../api/generated";
import { insecureRemote } from "../state/hosts";
import { pairingLink, pairingStatus, parsePairingLink, scanPairingImage } from "../state/pairing";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { connection, connectionLink, parseConnectionLink, validateConnection, type Connection } from "../api/transport";
import { deviceName } from "../state/device";
import { Icon } from "./icons";
import { SentenceText } from "./HelpTip";
import { DetailDialog } from "./ui/Controls";

type Issued = { id: string; code?: string; expires_at: string | null; encrypted?: Connection };

function PairingQr({ link }: { link: string }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState(false);
    useEffect(() => {
        let alive = true;
        setReady(false);
        setError(false);
        void import("qrcode").then(async ({ default: QRCode }) => {
            if (!alive) return;
            await QRCode.toCanvas(canvas.current!, link, { width: 280, margin: 4, errorCorrectionLevel: "M" });
            if (alive) setReady(true);
        }).catch(() => { if (alive) setError(true); });
        return () => { alive = false; };
    }, [link]);
    return <>
        <canvas ref={canvas} className="pairing-qr" aria-label="기기 페어링 QR" data-testid="pairing-qr" data-ready={ready} />
        {error && <p role="alert">QR을 만들지 못했습니다. 아래 링크를 사용하세요.</p>}
    </>;
}

export function Pairings({ showHeading = true }: { showHeading?: boolean }) {
    const list = useQuery<PairingInfo[]>("pairings", () => api.get("/pairings"));
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const passwordInput = useRef<HTMLInputElement>(null);
    const [replacing, setReplacing] = useState<string>();
    const [endpoint, setEndpoint] = useState(() => connection()?.endpoint ?? "");
    const [issued, setIssued] = useState<Issued | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const row = list.data?.find((p) => p.id === issued?.id);
    useEffect(() => {
        if (issued && ((issued.expires_at && Date.parse(issued.expires_at) <= now) || row?.consumed_at || row?.revoked_at || row?.locked_at)) setIssued(null);
    }, [issued, now, row]);
    const run = async (operation: () => Promise<void>) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError(null);
        try {
            await operation();
            list.reload();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "페어링을 처리하지 못했습니다.");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };
    const issue = async () => {
        let encrypted: Connection | undefined;
        const identity = await api.get<{ key: string; endpoint?: string | null }>("/e2ee/identity");
        const target = endpoint.trim() || identity.endpoint;
        if (target) encrypted = validateConnection({ endpoint: target, key: identity.key });
        const result = await api.post<Issued>("/pairings", { name: name.trim(), password, replace_id: replacing }, { requires: ["pairing_approval_v1"] });
        setIssued(result.code ? { ...result, encrypted } : null);
        setPassword("");
        setReplacing(undefined);
        if (!result.code) setError("이미 발급한 요청입니다. 비밀은 다시 표시하지 않습니다. 새 비밀번호로 재발급하세요.");
    };
    const link = issued?.code ? (issued.encrypted ? connectionLink(issued.encrypted, issued.code) : pairingLink(location.origin, issued.code)) : null;
    return (
        <section className="pairings" aria-label="기기 페어링">
            {showHeading && <h3>기기 페어링</h3>}
            <p className="muted small">만료 없음 · 링크당 기기 1대 · 비밀번호 5회 실패 시 잠금</p>
            {insecureRemote(location.origin) && <p className="warn"><SentenceText text="HTTP로는 비밀번호가 노출될 수 있습니다. HTTPS 또는 신뢰하는 VPN에서 사용하세요." /></p>}
            {["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && <p className="warn small">다른 기기 등록은 접속 가능한 HTTPS·VPN 주소에서 발급하세요.</p>}
            <form className="pairing-issue" aria-label="페어링 링크 발급" onSubmit={(e) => { e.preventDefault(); void run(issue); }}>
                <label>등록할 기기 이름<input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} /></label>
                <label className="pairing-password">링크 비밀번호<input ref={passwordInput} type="password" autoComplete="new-password" value={password} minLength={10} maxLength={256} placeholder="10자 이상" required onChange={(e) => setPassword(e.target.value)} /></label>
                <DetailDialog className="pairing-advanced" label="고급 연결 설정" title="고급 연결 설정">
                    <label>외부 암호화 연결 주소<input value={endpoint} placeholder="wss://서버/api/e2ee" onChange={(e) => setEndpoint(e.target.value)} /></label>
                </DetailDialog>
                <ServerActionButton type="submit" disabled={busy || !name.trim() || [...password].length < 10}>페어링 링크 발급</ServerActionButton>
            </form>
            {replacing && <p className="small">새 링크를 발급하면 선택한 이전 링크가 폐기됩니다. <button type="button" className="ghost small" onClick={() => setReplacing(undefined)}>재발급 취소</button></p>}
            {link && issued && <div className="pairing-issued">
                <PairingQr link={link} />
                <label>페어링 링크<input readOnly value={link} className="selectable" /></label>
                <p className="small muted">비밀번호는 링크와 따로 전달하세요.</p>
                <button type="button" className="ghost small" onClick={() => setIssued(null)}>링크 숨기기</button>
            </div>}
            {error && <p className="err" role="alert">{error}</p>}
            {!!list.error && <p className="err" role="alert">페어링 목록을 읽지 못했습니다.</p>}
            <ul className="pairing-list">
                {(list.data ?? []).map((info) => <li key={info.id} data-testid="pairing-row">
                    <div className="pairing-list-heading">
                        <div><strong>{info.name}</strong><span className={info.locked_at ? "err small" : "muted small"}>{pairingStatus(info, now)}{info.failed_attempts > 0 && ` · 비밀번호 실패 ${info.failed_attempts}/5`}</span></div>
                        <div className="row">
                            {!info.consumed_at && !info.revoked_at && <ServerActionButton type="button" className="ghost small" disabled={busy} onClick={() => void run(async () => {
                                await api.del(`/pairings/${info.id}`, { requires: ["pairing_approval_v1"] });
                                if (issued?.id === info.id) setIssued(null);
                            })}>링크 폐기</ServerActionButton>}
                            <button type="button" className="ghost small" disabled={busy} onClick={() => {
                                setReplacing(info.id); setName(info.name); setPassword(""); passwordInput.current?.focus();
                            }}>링크 재발급</button>
                        </div>
                    </div>
                    {!!info.requests.length && <div className="pairing-requests">
                        <p className="warn small">새 기기의 확인 코드와 같을 때만 승인하세요.</p>
                        {info.requests.filter((request) => Date.parse(request.expires_at) > now).map((request) => <div key={request.id} className="pairing-request">
                            <div><strong>{request.name}</strong><code>{request.verification_code}</code></div>
                            <div className="row">
                                <ServerActionButton type="button" disabled={busy} aria-label={`${request.verification_code} 기기 승인`} onClick={() => void run(async () => {
                                    await api.post(`/pairings/${info.id}/requests/${request.id}`, {}, { requires: ["pairing_approval_v1"] });
                                })}>승인</ServerActionButton>
                                <ServerActionButton type="button" className="ghost" disabled={busy} aria-label={`${request.verification_code} 기기 거절`} onClick={() => void run(async () => {
                                    await api.del(`/pairings/${info.id}/requests/${request.id}`, { requires: ["pairing_approval_v1"] });
                                })}>거절</ServerActionButton>
                            </div>
                        </div>)}
                    </div>}
                </li>)}
            </ul>
            {!!list.data?.length && <p className="muted small"><SentenceText text="링크 폐기는 등록 기기를 해제하지 않습니다. 분실 기기는 기기 목록에서 접근을 폐기하세요." /></p>}
        </section>
    );
}

export function PairingLogin({ initialLink = "", checking = false, onDone, onCancel }: { initialLink?: string; checking?: boolean; onDone: () => void; onCancel: () => void }) {
    const [link, setLink] = useState(initialLink);
    const [mode, setMode] = useState<"link" | "qr">("link");
    const [passwordOpen, setPasswordOpen] = useState(false);
    const [pending, setPending] = useState<PendingPairing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const sequence = useRef(0);
    const submitLock = useRef(false);
    const done = useRef(onDone);
    done.current = onDone;
    const loggedIn = isLoggedIn();
    useEffect(() => () => { sequence.current++; }, []);
    useEffect(() => {
        if (!pending) return;
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        const check = async () => {
            try {
                if (Date.parse(pending.expires_at) <= Date.now()) throw new Error("승인 요청이 만료되었습니다. 링크를 다시 열어 요청하세요.");
                const registered = await redeemPairing(pending.code);
                if (!active) return;
                if (registered) done.current();
                else timer = setTimeout(() => void check(), 2000);
            } catch (e) {
                if (active) setError(pairingError(e));
            }
        };
        void check();
        return () => { active = false; clearTimeout(timer); };
    }, [pending]);
    let target: { origin: string; code: string } | null = null;
    let encryptedTarget: string | null = null;
    try { target = parsePairingLink(link); } catch { /* 제출할 때 오류 안내 */ }
    try {
        const parsed = parseConnectionLink(link);
        encryptedTarget = connectionLink(parsed.connection, parsed.code);
    } catch { /* 동일 origin 링크도 지원한다. */ }
    const scan = async (file: File) => {
        const mine = ++sequence.current;
        setError(null);
        try {
            const result = await scanPairingImage(file);
            if (mine === sequence.current) setLink(result);
        } catch (e) {
            if (mine === sequence.current) setError(e instanceof Error ? e.message : "QR 이미지를 읽지 못했습니다.");
        }
    };
    return (
        <main className="login pairing-login">
            <form aria-label="페어링 등록" onSubmit={(e) => {
                e.preventDefault();
                if (submitLock.current || checking || loggedIn || pending) return;
                if (encryptedTarget) { location.assign(encryptedTarget); return; }
                let parsed: { origin: string; code: string };
                try { parsed = parsePairingLink(link); }
                catch (e) { setError((e as Error).message); return; }
                if (parsed.origin !== location.origin) return;
                setError(null);
                setPasswordOpen(true);
            }}>
                <span className="login-mark" aria-hidden="true"><Icon name="shield" size={28} /></span>
                <h1>기기 연결</h1>
                {pending ? <div className="pairing-wait" role="status">
                    <p>소유자 승인 대기 중</p>
                    <code className="pairing-code">{pending.verification_code}</code>
                    <p className="muted small">소유자의 기기에서 설정 · 기기 페어링을 열고 이 코드를 확인해 승인하세요.</p>
                    <p className="muted small">승인 요청 만료 <When at={pending.expires_at} absolute /></p>
                </div> : <>
                    <div className="pairing-mode" role="group" aria-label="연결 방식">
                        {(["link", "qr"] as const).map((value) => <button key={value} type="button" className="ghost"
                            aria-pressed={mode === value} onClick={() => { sequence.current++; setMode(value); setError(null); }}>
                            {value === "link" ? "페어링 링크" : "QR"}
                        </button>)}
                    </div>
                    {mode === "link" ? <label>페어링 링크<input value={link} autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => {
                        sequence.current++; setLink(e.target.value); setError(null);
                    }} /></label>
                    : <label className="pairing-file">QR 사진 선택<input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void scan(file);
                        e.target.value = "";
                    }} /></label>}
                    {target && <p className="small pairing-target">등록 대상: <strong className="host-address">{target.origin}</strong></p>}
                    {encryptedTarget && <p className="small pairing-target">등록 대상: <strong className="host-address">{new URL(parseConnectionLink(encryptedTarget).connection.endpoint).host}</strong></p>}
                    {checking && <p role="status">기존 로그인 상태 확인 중…</p>}
                    {loggedIn && <p role="status"><SentenceText text="이미 로그인된 브라우저입니다. 기존 로그인·초안을 덮어쓰지 않습니다. 별도 브라우저 프로필에서 등록하세요." /></p>}
                    {target && insecureRemote(target.origin) && <p className="warn small"><SentenceText text="암호화되지 않은 HTTP입니다. HTTPS 또는 신뢰하는 VPN에서 등록하세요." /></p>}
                    {target && target.origin !== location.origin
                        ? <a href={pairingLink(target.origin, target.code)} target="_blank" rel="noopener noreferrer">대상 서버에서 등록 확인</a>
                        : <ServerActionButton type="submit" disabled={busy || checking || loggedIn || !link.trim()}>{encryptedTarget ? "대상 서버로 이동" : "연결"}</ServerActionButton>}
                </>}
                {error && !passwordOpen && <p className="err" role="alert"><SentenceText text={error} /></p>}
                <button type="button" className="ghost" disabled={busy} onClick={onCancel}>토큰 로그인으로 돌아가기</button>
            </form>
            {passwordOpen && <PairingPasswordDialog busy={busy} error={error} onClose={() => { setPasswordOpen(false); setError(null); }}
                onSubmit={async (password) => {
                    if (submitLock.current || checking || isLoggedIn() || pending) return;
                    const parsed = parsePairingLink(link);
                    if (parsed.origin !== location.origin) return;
                    submitLock.current = true;
                    setBusy(true); setError(null);
                    try {
                        const request = await requestPairing(parsed.code, password, deviceName());
                        setPending(request); setPasswordOpen(false);
                    } catch (e) { setError(pairingError(e)); }
                    finally { submitLock.current = false; setBusy(false); }
                }} />}
        </main>
    );
}

function PairingPasswordDialog({ busy, error, onClose, onSubmit }: {
    busy: boolean; error: string | null; onClose: () => void; onSubmit: (password: string) => Promise<void>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [password, setPassword] = useState("");
    useEffect(() => {
        const element = dialog.current!;
        element.showModal();
        return () => element.close();
    }, []);
    return <dialog ref={dialog} className="dialog pairing-password-dialog" aria-label="연결 비밀번호"
        onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
        <form onSubmit={(event) => { event.preventDefault(); void onSubmit(password); }}>
            <h2>비밀번호</h2>
            <label>비밀번호<input autoFocus type="password" autoComplete="current-password" maxLength={256}
                required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <p className="muted small">비밀번호 5회 실패 시 링크가 잠깁니다.</p>
            <p className="muted small">승인된 기기는 모든 프로젝트·파일에 접근하고 명령을 실행할 수 있습니다.</p>
            {error && <p className="err" role="alert"><SentenceText text={error} /></p>}
            <div className="actions">
                <ServerActionButton type="submit" disabled={busy || !password}>{busy ? "확인 중…" : "연결 요청"}</ServerActionButton>
                <button type="button" className="ghost" disabled={busy} onClick={onClose}>취소</button>
            </div>
        </form>
    </dialog>;
}

function pairingError(e: unknown): string {
    const unknown = e instanceof ApiError && (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
    return unknown ? "연결 결과를 확인하지 못했습니다. 새로고침해 로그인을 확인하세요. 실패하면 소유자가 요청·기기 목록을 확인한 뒤 폐기·재발급하세요. 자동 재등록하지 않습니다."
        : e instanceof Error ? e.message : "연결하지 못했습니다.";
}
