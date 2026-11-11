import { useEffect, useRef, useState } from "react";
import { ApiError, api, isLoggedIn, redeemPairing } from "../api/client";
import type { PairingInfo } from "../api/generated";
import { insecureRemote } from "../state/hosts";
import { pairingLink, pairingStatus, parsePairingLink, scanPairingImage } from "../state/pairing";
import { useQuery } from "../state/store";

type Issued = { id: string; code?: string; expires_at: string };

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
        <canvas ref={canvas} className="pairing-qr" aria-label="일회용 페어링 QR" data-testid="pairing-qr" data-ready={ready} />
        {error && <p role="alert">QR을 만들지 못했습니다. 아래 링크를 사용하세요.</p>}
    </>;
}

export function Pairings() {
    const list = useQuery<PairingInfo[]>("pairings", () => api.get("/pairings"));
    const [name, setName] = useState("");
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
        if (issued && (Date.parse(issued.expires_at) <= now || row?.consumed_at || row?.revoked_at)) setIssued(null);
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
    const issue = async (deviceName: string, replace_id?: string) => {
        const result = await api.post<Issued>("/pairings", { name: deviceName, replace_id }, { requires: ["pairing_v1"] });
        setIssued(result.code ? result : null);
        if (!result.code) setError("이미 발급한 요청이라 비밀을 다시 표시할 수 없습니다. 목록에서 링크를 재발급하세요.");
    };
    const link = issued?.code ? pairingLink(location.origin, issued.code) : null;
    return (
        <section className="pairings" aria-label="기기 페어링">
            <h3>QR·링크로 기기 등록</h3>
            <p className="muted small">5분 동안 한 번만 사용할 수 있습니다. 링크를 가진 사람은 기기를 등록할 수 있으니 신뢰하는 사람에게만 전달하세요. 소유자 토큰·비밀번호·장기 기기 토큰은 포함하지 않습니다.</p>
            <p className="small">대상 서버: <code className="host-address">{location.origin}</code></p>
            {insecureRemote(location.origin) && <p className="warn">HTTP로는 등록 자격이 노출될 수 있습니다. HTTPS 또는 신뢰하는 VPN에서 사용하세요.</p>}
            {["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && <p className="warn small">현재 주소는 loopback입니다. 다른 기기에 전달하려면 그 기기에서 접속 가능한 HTTPS·VPN 주소로 이 화면을 열어 발급하세요.</p>}
            <form className="row" aria-label="페어링 링크 발급" onSubmit={(e) => { e.preventDefault(); void run(() => issue(name.trim())); }}>
                <label>등록할 기기 이름<input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} /></label>
                <button type="submit" disabled={busy || !name.trim()}>페어링 링크 발급</button>
            </form>
            {link && issued && <div className="draft-note">
                <PairingQr link={link} />
                <label>일회용 페어링 링크<input readOnly value={link} className="selectable" /></label>
                <p className="small">만료: {new Date(issued.expires_at).toLocaleString()}. 원문은 이 화면에서만 표시됩니다.</p>
                <button type="button" className="ghost small" onClick={() => setIssued(null)}>링크 숨기기</button>
            </div>}
            {error && <p className="err" role="alert">{error}</p>}
            {!!list.error && <p className="err" role="alert">페어링 목록을 읽지 못했습니다.</p>}
            <ul className="host-list">
                {(list.data ?? []).map((info) => <li key={info.id} data-testid="pairing-row">
                    <strong>{info.name}</strong>
                    <span>{pairingStatus(info, now)} · 만료 {new Date(info.expires_at).toLocaleString()}</span>
                    <div className="row">
                        {!info.consumed_at && !info.revoked_at && <button type="button" className="ghost small" disabled={busy} onClick={() => void run(async () => {
                            await api.del(`/pairings/${info.id}`, { requires: ["pairing_v1"] });
                            if (issued?.id === info.id) setIssued(null);
                        })}>링크 폐기</button>}
                        <button type="button" className="ghost small" disabled={busy} onClick={() => void run(() => issue(info.name, info.id))}>링크 재발급</button>
                    </div>
                </li>)}
            </ul>
            <p className="muted small">사용한 링크를 폐기·재발급해도 이미 등록한 기기는 해제되지 않습니다. 분실 기기의 접근은 위 기기 목록에서 폐기하세요.</p>
        </section>
    );
}

export function PairingLogin({ initialLink = "", checking = false, onDone, onCancel }: { initialLink?: string; checking?: boolean; onDone: () => void; onCancel: () => void }) {
    const [link, setLink] = useState(initialLink);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const sequence = useRef(0);
    const loggedIn = isLoggedIn();
    useEffect(() => () => { sequence.current++; }, []);
    let target: { origin: string; code: string } | null = null;
    try { target = parsePairingLink(link); } catch { /* 제출할 때 오류 안내 */ }
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
        <main className="login">
            <form aria-label="페어링 등록" onSubmit={(e) => {
                e.preventDefault();
                let parsed: { origin: string; code: string };
                try { parsed = parsePairingLink(link); }
                catch (e) { setError((e as Error).message); return; }
                if (parsed.origin !== location.origin || busy || checking || loggedIn) return;
                setBusy(true);
                setError(null);
                void redeemPairing(parsed.code).then(onDone).catch((e) => {
                    const unknown = e instanceof ApiError && e.status === 0;
                    setError(unknown ? "등록 결과를 확인하지 못했습니다. 새로고침해 로그인을 확인하고, 실패하면 소유자가 기기 목록을 확인한 뒤 폐기·재발급하세요. 자동 재등록하지 않습니다." : e instanceof ApiError ? e.message : "등록하지 못했습니다.");
                }).finally(() => setBusy(false));
            }}>
                <h1>기기 페어링</h1>
                <p className="small">QR 사진을 선택하거나 링크를 붙여 넣으세요. 서버 주소를 확인한 뒤 등록하세요. 사진은 이 기기에서만 처리합니다.</p>
                <label>페어링 링크<input value={link} autoComplete="off" spellCheck={false} onChange={(e) => { sequence.current++; setLink(e.target.value); setError(null); }} /></label>
                <label>페어링 QR 사진<input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void scan(file);
                    e.target.value = "";
                }} /></label>
                {target && <p>등록 대상: <strong className="host-address">{target.origin}</strong></p>}
                {checking && <p role="status">기존 로그인 상태 확인 중…</p>}
                {loggedIn && <p role="status">이미 로그인된 브라우저입니다. 기존 로그인·초안을 덮어쓰지 않습니다. 별도 브라우저 프로필에서 등록하세요.</p>}
                {target && insecureRemote(target.origin) && <p className="warn">암호화되지 않은 HTTP입니다. HTTPS 또는 신뢰하는 VPN에서 등록하세요.</p>}
                {target && target.origin !== location.origin
                    ? <a href={pairingLink(target.origin, target.code)} target="_blank" rel="noopener noreferrer">대상 서버에서 등록 확인</a>
                    : <button type="submit" disabled={busy || checking || loggedIn || !link.trim()}>{busy ? "등록 중…" : "이 기기 등록"}</button>}
                <p className="muted small">등록하면 이 브라우저가 대상 서버에 접근할 수 있습니다. 링크는 5분 뒤 만료되며 한 번만 사용할 수 있습니다.</p>
                {error && <p className="err" role="alert">{error}</p>}
                <button type="button" className="ghost" disabled={busy} onClick={onCancel}>토큰 로그인으로 돌아가기</button>
            </form>
        </main>
    );
}
