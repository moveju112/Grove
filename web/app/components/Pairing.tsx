import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
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
import { LoadingBar } from "./LoadingScreen";
import { TextInput } from "../design/Fields";

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
        {error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">QR을 만들지 못했습니다. 아래 링크를 사용하세요.</GroveText>}
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
            {showHeading && <GroveHeading level={3} color="inherit">기기 페어링</GroveHeading>}
            <GroveText as="p" display="block" type="supporting" color="secondary">만료 없음 · 링크당 기기 1대 · 비밀번호 5회 실패 시 잠금</GroveText>
            {insecureRemote(location.origin) && <GroveText as="p" display="block" type="inherit" color="warning"><SentenceText text="HTTP로는 비밀번호가 노출될 수 있습니다. HTTPS 또는 신뢰하는 VPN에서 사용하세요." /></GroveText>}
            {["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && <GroveText as="p" display="block" type="supporting" color="warning">다른 기기 등록은 접속 가능한 HTTPS·VPN 주소에서 발급하세요.</GroveText>}
            <form className="pairing-issue" aria-label="페어링 링크 발급" onSubmit={(e) => { e.preventDefault(); void run(issue); }}>
                <TextInput label="등록할 기기 이름" value={name} maxLength={80} isRequired onChange={setName} />
                <TextInput label="링크 비밀번호" containerClassName="pairing-password" ref={passwordInput} type="password" autoComplete="new-password" value={password} minLength={10} maxLength={256} placeholder="10자 이상" isRequired onChange={setPassword} />
                <DetailDialog className="pairing-advanced" label="고급 연결 설정" title="고급 연결 설정">
                    <TextInput label="외부 암호화 연결 주소" value={endpoint} placeholder="wss://서버/api/e2ee" onChange={setEndpoint} />
                </DetailDialog>
                <ServerActionButton type="submit" disabled={busy || !name.trim() || [...password].length < 10}>페어링 링크 발급</ServerActionButton>
            </form>
            {replacing && <GroveText as="p" display="block" type="supporting" color="inherit">새 링크를 발급하면 선택한 이전 링크가 폐기됩니다. <GroveButton type="button" className="ghost small" onClick={() => setReplacing(undefined)}>재발급 취소</GroveButton></GroveText>}
            {link && issued && <div className="pairing-issued">
                <PairingQr link={link} />
                <TextInput label="페어링 링크" isReadOnly value={link} controlClassName="selectable" />
                <GroveText as="p" display="block" type="supporting" color="secondary">비밀번호는 링크와 따로 전달하세요.</GroveText>
                <GroveButton type="button" className="ghost small" onClick={() => setIssued(null)}>링크 숨기기</GroveButton>
            </div>}
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
            {!!list.error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">페어링 목록을 읽지 못했습니다.</GroveText>}
            <ul className="pairing-list">
                {(list.data ?? []).map((info) => <li key={info.id} data-testid="pairing-row">
                    <div className="pairing-list-heading">
                        <div><strong>{info.name}</strong><GroveText type="supporting" color={info.locked_at ? "error" : "secondary"}>{pairingStatus(info, now)}{info.failed_attempts > 0 && ` · 비밀번호 실패 ${info.failed_attempts}/5`}</GroveText></div>
                        <GroveStack direction="horizontal" align="center" className="row">
                            {!info.consumed_at && !info.revoked_at && <ServerActionButton type="button" className="ghost small" disabled={busy} onClick={() => void run(async () => {
                                await api.del(`/pairings/${info.id}`, { requires: ["pairing_approval_v1"] });
                                if (issued?.id === info.id) setIssued(null);
                            })}>링크 폐기</ServerActionButton>}
                            <GroveButton type="button" className="ghost small" disabled={busy} onClick={() => {
                                setReplacing(info.id); setName(info.name); setPassword(""); passwordInput.current?.focus();
                            }}>링크 재발급</GroveButton>
                        </GroveStack>
                    </div>
                    {!!info.requests.length && <div className="pairing-requests">
                        <GroveText as="p" display="block" type="supporting" color="warning">새 기기의 확인 코드와 같을 때만 승인하세요.</GroveText>
                        {info.requests.filter((request) => Date.parse(request.expires_at) > now).map((request) => <div key={request.id} className="pairing-request">
                            <div><strong>{request.name}</strong><code>{request.verification_code}</code></div>
                            <GroveStack direction="horizontal" align="center" className="row">
                                <ServerActionButton type="button" disabled={busy} aria-label={`${request.verification_code} 기기 승인`} onClick={() => void run(async () => {
                                    await api.post(`/pairings/${info.id}/requests/${request.id}`, {}, { requires: ["pairing_approval_v1"] });
                                })}>승인</ServerActionButton>
                                <ServerActionButton type="button" className="ghost" disabled={busy} aria-label={`${request.verification_code} 기기 거절`} onClick={() => void run(async () => {
                                    await api.del(`/pairings/${info.id}/requests/${request.id}`, { requires: ["pairing_approval_v1"] });
                                })}>거절</ServerActionButton>
                            </GroveStack>
                        </div>)}
                    </div>}
                </li>)}
            </ul>
            {!!list.data?.length && <GroveText as="p" display="block" type="supporting" color="secondary"><SentenceText text="링크 폐기는 등록 기기를 해제하지 않습니다. 분실 기기는 기기 목록에서 접근을 폐기하세요." /></GroveText>}
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
        // 이동 후 뒤로 가기로 복원된 페이지는 진행 중 상태를 풀어 다시 조작할 수 있게 한다.
        const restore = (event: PageTransitionEvent) => { if (event.persisted && !submitLock.current) setBusy(false); };
        window.addEventListener("pageshow", restore);
        return () => window.removeEventListener("pageshow", restore);
    }, []);
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
    let encrypted: ReturnType<typeof parseConnectionLink> | null = null;
    try { target = parsePairingLink(link); } catch { /* 제출할 때 오류 안내 */ }
    try { encrypted = parseConnectionLink(link); } catch { /* 동일 origin 링크도 지원한다. */ }
    let current: Connection | null = null;
    try { current = connection(); } catch { /* 손상된 연결은 이동 경로에서 다시 확인한다. */ }
    // 이미 이 암호화 서버에 연결돼 있으면 같은 문서의 hash만 바꾸는 이동 대신 이 자리에서 등록한다.
    const sameServer = !!encrypted && current?.endpoint === encrypted.connection.endpoint && current.key === encrypted.connection.key;
    const encryptedCode = sameServer ? encrypted!.code ?? null : null;
    const encryptedTarget = encrypted && !sameServer ? connectionLink(encrypted.connection, encrypted.code) : null;
    // 비밀번호 모달이 사용할 이 서버의 페어링 코드. 다른 서버 링크면 null이다.
    const localCode = sameServer ? encryptedCode : target?.origin === location.origin ? target.code : null;
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
            {(busy || checking) && <LoadingBar label={busy ? "기기 연결 진행 중" : "로그인 상태 확인 중"} />}
            <form aria-label="페어링 등록" onSubmit={(e) => {
                e.preventDefault();
                if (submitLock.current || checking || loggedIn || pending) return;
                if (encryptedTarget) {
                    // 다른 문서로 이동하는 동안 진행 표시를 유지한다.
                    setBusy(true);
                    location.assign(encryptedTarget);
                    return;
                }
                if (sameServer && !encryptedCode) { setError("페어링 코드가 없는 연결 링크입니다."); return; }
                if (!sameServer) {
                    try { parsePairingLink(link); }
                    catch (e) { setError((e as Error).message); return; }
                }
                if (!localCode) return;
                setError(null);
                setPasswordOpen(true);
            }}>
                <GroveText type="inherit" color="inherit" className="login-mark" aria-hidden="true"><Icon name="shield" size={28} /></GroveText>
                <GroveHeading level={1} color="inherit">기기 연결</GroveHeading>
                {pending ? <div className="pairing-wait" role="status">
                    <GroveText as="p" display="block" type="inherit" color="inherit">소유자 승인 대기 중</GroveText>
                    <code className="pairing-code">{pending.verification_code}</code>
                    <GroveText as="p" display="block" type="supporting" color="secondary">소유자의 기기에서 설정 · 기기 페어링을 열고 이 코드를 확인해 승인하세요.</GroveText>
                    <GroveText as="p" display="block" type="supporting" color="secondary">승인 요청 만료 <When at={pending.expires_at} absolute /></GroveText>
                </div> : <>
                    <div className="pairing-mode" role="group" aria-label="연결 방식">
                        {(["link", "qr"] as const).map((value) => <GroveButton key={value} type="button" className="ghost"
                            aria-pressed={mode === value} onClick={() => { sequence.current++; setMode(value); setError(null); }}>
                            {value === "link" ? "페어링 링크" : "QR"}
                        </GroveButton>)}
                    </div>
                    {mode === "link" ? <TextInput label="페어링 링크" value={link} autoComplete="off" hasSpellCheck={false} isDisabled={busy} onChange={(value) => {
                        sequence.current++; setLink(value); setError(null);
                    }} />
                    : <label className="pairing-file">QR 사진 선택<input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void scan(file);
                        e.target.value = "";
                    }} /></label>}
                    {target && <GroveText as="p" display="block" type="supporting" color="inherit" className="pairing-target">등록 대상: <strong className="host-address">{target.origin}</strong></GroveText>}
                    {encrypted && <GroveText as="p" display="block" type="supporting" color="inherit" className="pairing-target">등록 대상: <strong className="host-address">{new URL(encrypted.connection.endpoint).host}</strong></GroveText>}
                    {checking && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">기존 로그인 상태 확인 중…</GroveText>}
                    {loggedIn && <GroveText as="p" display="block" type="inherit" color="inherit" role="status"><SentenceText text="이미 로그인된 브라우저이니 기존 로그인·초안을 보존하려면 별도 프로필에서 등록하세요." /></GroveText>}
                    {target && insecureRemote(target.origin) && <GroveText as="p" display="block" type="supporting" color="warning"><SentenceText text="암호화되지 않은 HTTP입니다. HTTPS 또는 신뢰하는 VPN에서 등록하세요." /></GroveText>}
                    {target && target.origin !== location.origin
                        ? <Link type="inherit" href={pairingLink(target.origin, target.code)} target="_blank" rel="noopener noreferrer">대상 서버에서 등록 확인</Link>
                        : <ServerActionButton type="submit" disabled={busy || checking || loggedIn || !link.trim()}>{busy ? (encryptedTarget ? "이동 중…" : "확인 중…") : encryptedTarget ? "대상 서버로 이동" : "연결"}</ServerActionButton>}
                </>}
                {error && !passwordOpen && <GroveText as="p" display="block" type="inherit" color="error" role="alert"><SentenceText text={error} /></GroveText>}
                <GroveButton type="button" className="ghost" disabled={busy} onClick={onCancel}>토큰 로그인으로 돌아가기</GroveButton>
            </form>
            {passwordOpen && <PairingPasswordDialog busy={busy} error={error} onClose={() => { setPasswordOpen(false); setError(null); }}
                onSubmit={async (password) => {
                    if (submitLock.current || checking || isLoggedIn() || pending || !localCode) return;
                    submitLock.current = true;
                    setBusy(true); setError(null);
                    try {
                        const request = await requestPairing(localCode, password, deviceName());
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
            <GroveHeading level={2} color="inherit">비밀번호</GroveHeading>
            <TextInput label="비밀번호" hasAutoFocus type="password" autoComplete="current-password" maxLength={256}
                isRequired isDisabled={busy} value={password} onChange={setPassword} />
            <GroveText as="p" display="block" type="supporting" color="secondary">비밀번호 5회 실패 시 링크가 잠깁니다.</GroveText>
            <GroveText as="p" display="block" type="supporting" color="secondary">승인된 기기는 모든 프로젝트·파일에 접근하고 명령을 실행할 수 있습니다.</GroveText>
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert"><SentenceText text={error} /></GroveText>}
            <div className="actions">
                <ServerActionButton type="submit" disabled={busy || !password}>{busy ? "확인 중…" : "연결 요청"}</ServerActionButton>
                <GroveButton type="button" className="ghost" disabled={busy} onClick={onClose}>취소</GroveButton>
            </div>
        </form>
    </dialog>;
}

function pairingError(e: unknown): string {
    const unknown = e instanceof ApiError && (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
    return unknown ? "연결 결과를 확인하지 못했습니다. 새로고침해 로그인을 확인하세요. 실패하면 소유자가 요청·기기 목록을 확인한 뒤 폐기·재발급하세요. 자동 재등록하지 않습니다."
        : e instanceof Error ? e.message : "연결하지 못했습니다.";
}
