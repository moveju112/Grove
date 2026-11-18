import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { TextInput, FileInput } from "../design/Fields";
import { CreationDialog } from "./create/CreationDialog";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Code } from "@astryxdesign/core/Code";
import { contentStyles } from "../design/content.stylex";
import * as stylex from "@stylexjs/stylex";

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
        <canvas ref={canvas} {...stylex.props(contentStyles.qr)} aria-label="기기 페어링 QR" data-testid="pairing-qr" data-ready={ready} />
        {error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">QR을 만들지 못했습니다. 아래 링크를 사용하세요.</GroveText>}
    </>;
}

export function Pairings({ showHeading = true }: { showHeading?: boolean }) {
    const list = useQuery<PairingInfo[]>("pairings", () => api.get("/pairings"));
    const [issueOpen, setIssueOpen] = useState(false);
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [replacing, setReplacing] = useState<string>();
    const [endpoint, setEndpoint] = useState(() => connection()?.endpoint ?? "");
    const [issued, setIssued] = useState<Issued | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const issueOpener = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
        if (!issueOpen && !busy && issueOpener.current) {
            // 중첩 modal을 제거하면 브라우저가 설정창 자체로 돌려놓기도 하므로 실제 발급 버튼으로 복귀한다.
            issueOpener.current.focus({ preventScroll: true });
            issueOpener.current = null;
        }
    }, [issueOpen, busy]);
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
        if (result.code) {
            setIssueOpen(false);
            setName("");
        } else setError("이미 발급한 요청입니다. 비밀은 다시 표시하지 않습니다. 새 비밀번호로 재발급하세요.");
    };
    const closeIssue = () => {
        setIssueOpen(false);
        setName("");
        setPassword("");
        setReplacing(undefined);
        setError(null);
    };
    const link = issued?.code ? (issued.encrypted ? connectionLink(issued.encrypted, issued.code) : pairingLink(location.origin, issued.code)) : null;
    return (
        <GroveStack as="section" gap={3} aria-label="기기 페어링">
            {showHeading && <GroveHeading level={3} color="inherit">기기 페어링</GroveHeading>}
            <GroveText as="p" display="block" type="supporting" color="secondary">링크당 기기 1대만 등록할 수 있어요. 등록한 기기는 모두 같은 관리 권한을 가져요.</GroveText>
            {insecureRemote(location.origin) && <GroveText as="p" display="block" type="inherit" color="warning"><SentenceText text="HTTP로는 비밀번호가 노출될 수 있습니다. HTTPS 또는 신뢰하는 VPN에서 사용하세요." /></GroveText>}
            {["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && <GroveText as="p" display="block" type="supporting" color="warning">다른 기기 등록은 접속 가능한 HTTPS·VPN 주소에서 발급하세요.</GroveText>}
            <ServerActionButton type="button" disabled={busy} onClick={(event) => {
                issueOpener.current = event.currentTarget;
                setName(""); setPassword(""); setReplacing(undefined); setError(null); setIssueOpen(true);
            }}>페어링 링크 발급</ServerActionButton>
            <DetailDialog label="고급 연결 설정" title="고급 연결 설정">
                <TextInput label="외부 암호화 연결 주소" value={endpoint} placeholder="wss://서버/api/e2ee" onChange={setEndpoint} />
            </DetailDialog>
            {issueOpen && <CreationDialog label="페어링 링크 발급" onClose={closeIssue} busy={busy}>
                <GroveHeading level={2}>페어링 링크 발급</GroveHeading>
                <GroveStack as="form" gap={3} aria-label="페어링 링크 발급" onSubmit={(e) => { e.preventDefault(); void run(issue); }}>
                    <TextInput label="표시할 이름" value={name} maxLength={80} isRequired hasAutoFocus onChange={setName} />
                    <TextInput label="링크 비밀번호" type="password" autoComplete="new-password" value={password} minLength={10} maxLength={256} placeholder="10자 이상" isRequired onChange={setPassword} />
                    {replacing && <GroveText as="p" type="supporting" color="warning">새 링크를 발급하면 선택한 이전 링크가 폐기됩니다.</GroveText>}
                    {error && <GroveText as="p" color="error" role="alert">{error}</GroveText>}
                    <GroveStack direction="horizontal" justify="end" gap={2}>
                        <GroveButton type="button" variant="secondary" onClick={closeIssue}>취소</GroveButton>
                        <ServerActionButton type="submit" disabled={busy || !name.trim() || [...password].length < 10}>발급</ServerActionButton>
                    </GroveStack>
                </GroveStack>
            </CreationDialog>}
            {link && issued && <GroveStack gap={3} paddingBlock={4}>
                <PairingQr link={link} />
                <TextInput label="페어링 링크" isReadOnly value={link} controlXstyle={contentStyles.selectable} />
                <GroveText as="p" display="block" type="supporting" color="secondary">비밀번호는 링크와 따로 전달하세요.</GroveText>
                <GroveButton type="button" variant="secondary" density="compact" onClick={() => setIssued(null)}>링크 숨기기</GroveButton>
            </GroveStack>}
            {error && !issueOpen && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
            {!!list.error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">페어링 목록을 읽지 못했습니다.</GroveText>}
            <GroveList density="compact" edge="flush" hasDividers>
                {(list.data ?? []).map((info) => <GroveListItem key={info.id} data-testid="pairing-row" label={<>
                    <GroveStack gap={3} direction="horizontal" align="center" justify="between" wrap="wrap">
                        <GroveStack gap={0}><strong>{info.name}</strong><GroveText type="supporting" color={info.locked_at ? "error" : "secondary"}>{pairingStatus(info, now)}{info.failed_attempts > 0 && ` · 비밀번호 실패 ${info.failed_attempts}/5`}</GroveText></GroveStack>
                        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                            {!info.consumed_at && !info.revoked_at && <ServerActionButton type="button" variant="secondary" density="compact" disabled={busy} onClick={() => void run(async () => {
                                await api.del(`/pairings/${info.id}`, { requires: ["pairing_approval_v1"] });
                                if (issued?.id === info.id) setIssued(null);
                            })}>링크 폐기</ServerActionButton>}
                            <GroveButton type="button" variant="secondary" density="compact" disabled={busy} onClick={(event) => {
                                issueOpener.current = event.currentTarget;
                                setReplacing(info.id); setName(info.name); setPassword(""); setError(null); setIssueOpen(true);
                            }}>링크 재발급</GroveButton>
                        </GroveStack>
                    </GroveStack>
                    {!!info.requests.length && <Card variant="muted" padding={4}><GroveStack gap={4}>
                        <GroveText as="p" display="block" type="supporting" color="warning">새 기기의 확인 코드와 같을 때만 승인하세요.</GroveText>
                        {info.requests.filter((request) => Date.parse(request.expires_at) > now).map((request) => <GroveStack gap={3} direction="horizontal" align="center" justify="between" wrap="wrap" key={request.id}>
                            <GroveStack gap={0}><strong>{request.name}</strong><code>{request.verification_code}</code></GroveStack>
                            <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                                <ServerActionButton type="button" disabled={busy} aria-label={`${request.verification_code} 기기 승인`} onClick={() => void run(async () => {
                                    await api.post(`/pairings/${info.id}/requests/${request.id}`, {}, { requires: ["pairing_approval_v1"] });
                                })}>승인</ServerActionButton>
                                <ServerActionButton type="button" variant="secondary" disabled={busy} aria-label={`${request.verification_code} 기기 거절`} onClick={() => void run(async () => {
                                    await api.del(`/pairings/${info.id}/requests/${request.id}`, { requires: ["pairing_approval_v1"] });
                                })}>거절</ServerActionButton>
                            </GroveStack>
                        </GroveStack>)}
                    </GroveStack></Card>}
                </>} />)}
            </GroveList>
            {!!list.data?.length && <GroveText as="p" display="block" type="supporting" color="secondary"><SentenceText text="링크 폐기는 등록 기기를 해제하지 않습니다. 분실 기기는 기기 목록에서 접근을 폐기하세요." /></GroveText>}
        </GroveStack>
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
        <Center role="main" minHeight="100dvh" padding={4}>
            {(busy || checking) && <LoadingBar label={busy ? "기기 연결 진행 중" : "로그인 상태 확인 중"} />}
            <Card width={420} maxWidth="100%" padding={8}><GroveStack as="form" gap={4} aria-label="페어링 등록" onSubmit={(e) => {
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
                <GroveText type="inherit" color="brand" aria-hidden="true"><Icon name="shield" size={28} /></GroveText>
                <GroveHeading level={1} color="inherit">기기 연결</GroveHeading>
                {pending ? <GroveStack gap={4} role="status">
                    <GroveText as="p" display="block" type="inherit" color="inherit">기기 승인 대기 중</GroveText>
                    <Card variant="muted" padding={4}><Code data-testid="pairing-code">{pending.verification_code}</Code></Card>
                    <GroveText as="p" display="block" type="supporting" color="secondary">등록된 기기의 설정에서 이 코드를 대조해 승인하세요. 첫 기기는 서버 터미널에서 승인해 주세요.</GroveText>
                    <GroveText as="p" display="block" type="supporting" color="secondary">승인 요청 만료 <When at={pending.expires_at} absolute /></GroveText>
                </GroveStack> : <>
                    <GroveStack direction="horizontal" gap={1} role="group" aria-label="연결 방식">
                        {(["link", "qr"] as const).map((value) => <GroveButton key={value} type="button" appearance="choice"
                            aria-pressed={mode === value} onClick={() => { sequence.current++; setMode(value); setError(null); }}>
                            {value === "link" ? "페어링 링크" : "QR"}
                        </GroveButton>)}
                    </GroveStack>
                    {mode === "link" ? <TextInput label="페어링 링크" value={link} autoComplete="off" hasSpellCheck={false} isDisabled={busy} onChange={(value) => {
                        sequence.current++; setLink(value); setError(null);
                    }} />
                    : <FileInput label="QR 사진 선택" accept="image/*" capture="environment" isDisabled={busy} value={null} onChange={(files) => {
                        const file = Array.isArray(files) ? files[0] : files;
                        if (file) void scan(file);
                    }} />}
                    {target && <GroveText as="p" display="block" type="supporting" color="inherit">등록 대상: <Code>{target.origin}</Code></GroveText>}
                    {encrypted && <GroveText as="p" display="block" type="supporting" color="inherit">등록 대상: <Code>{new URL(encrypted.connection.endpoint).host}</Code></GroveText>}
                    {checking && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">기존 로그인 상태 확인 중…</GroveText>}
                    {loggedIn && <GroveText as="p" display="block" type="inherit" color="inherit" role="status"><SentenceText text="이미 로그인된 브라우저이니 기존 로그인·초안을 보존하려면 별도 프로필에서 등록하세요." /></GroveText>}
                    {target && insecureRemote(target.origin) && <GroveText as="p" display="block" type="supporting" color="warning"><SentenceText text="암호화되지 않은 HTTP입니다. HTTPS 또는 신뢰하는 VPN에서 등록하세요." /></GroveText>}
                    {target && target.origin !== location.origin
                        ? <Link type="inherit" href={pairingLink(target.origin, target.code)} target="_blank" rel="noopener noreferrer">대상 서버에서 등록 확인</Link>
                        : <ServerActionButton type="submit" disabled={busy || checking || loggedIn || !link.trim()}>{busy ? (encryptedTarget ? "이동 중…" : "확인 중…") : encryptedTarget ? "대상 서버로 이동" : "연결"}</ServerActionButton>}
                </>}
                {error && !passwordOpen && <GroveText as="p" display="block" type="inherit" color="error" role="alert"><SentenceText text={error} /></GroveText>}
                <GroveButton type="button" variant="secondary" disabled={busy} onClick={onCancel}>돌아가기</GroveButton>
            </GroveStack></Card>
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
        </Center>
    );
}

function PairingPasswordDialog({ busy, error, onClose, onSubmit }: {
    busy: boolean; error: string | null; onClose: () => void; onSubmit: (password: string) => Promise<void>;
}) {
    const [password, setPassword] = useState("");
    return <CreationDialog label="연결 비밀번호" width={420} busy={busy} onClose={() => { if (!busy) onClose(); }}>
        <form onSubmit={(event) => { event.preventDefault(); void onSubmit(password); }}>
            <GroveHeading level={2} color="inherit">비밀번호</GroveHeading>
            <TextInput label="비밀번호" hasAutoFocus type="password" autoComplete="current-password" maxLength={256}
                isRequired isDisabled={busy} value={password} onChange={setPassword} />
            <GroveText as="p" display="block" type="supporting" color="secondary">비밀번호 5회 실패 시 링크가 잠깁니다.</GroveText>
            <GroveText as="p" display="block" type="supporting" color="secondary">승인된 기기는 모든 프로젝트·파일에 접근하고 명령을 실행할 수 있습니다.</GroveText>
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert"><SentenceText text={error} /></GroveText>}
            <GroveStack gap={2} direction="horizontal" align="center" wrap="wrap">
                <ServerActionButton type="submit" disabled={busy || !password}>{busy ? "확인 중…" : "연결 요청"}</ServerActionButton>
                <GroveButton type="button" variant="secondary" disabled={busy} onClick={onClose}>취소</GroveButton>
            </GroveStack>
        </form>
    </CreationDialog>;
}

function pairingError(e: unknown): string {
    const unknown = e instanceof ApiError && (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
    return unknown ? "연결 결과를 확인하지 못했어요. 새로고침한 뒤에도 로그인되지 않으면 등록된 기기나 서버 터미널에서 새 링크를 발급하세요."
        : e instanceof Error ? e.message : "연결하지 못했습니다.";
}
