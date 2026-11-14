import { Fragment, useEffect, useState, type ReactNode } from "react";
import { configureConnection, connection, parseConnectionLink } from "../api/transport";
import { pairingLink, scanPairingImage } from "../state/pairing";

/** 이미 신뢰한 서버와 같은 연결 링크는 다시 확인하지 않고 페어링 hash로 바꾼다. */
function adoptKnownLink(): boolean {
    if (!location.hash.startsWith("#connect=")) return false;
    try {
        const parsed = parseConnectionLink(location.href);
        const current = connection();
        if (current?.endpoint !== parsed.connection.endpoint || current.key !== parsed.connection.key) return false;
        const hash = parsed.code ? new URL(pairingLink(location.origin, parsed.code)).hash : "";
        history.replaceState(history.state, "", location.pathname + location.search + hash);
        return true;
    } catch { return false; }
}

/// Pages의 bootstrap 단계. 신뢰할 링크의 pin을 확인하기 전에는 API·토큰을 보내지 않는다.
export function EncryptedConnection({ children }: { children: ReactNode }) {
    const [link, setLink] = useState(() => location.hash.startsWith("#connect=") ? location.href : "");
    const [ready, setReady] = useState(() => {
        if (location.hash.startsWith("#connect=")) return adoptKnownLink();
        try { return !!connection() || location.hostname !== "grove.choondoggy.com"; }
        catch { return false; }
    });
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        // 앱을 연 채 주소창의 연결 링크로 이동하면 문서가 다시 로드되지 않으므로 직접 처리한다.
        const receive = () => {
            if (!location.hash.startsWith("#connect=")) return;
            setError(null);
            if (adoptKnownLink()) { setReady(true); setGeneration((value) => value + 1); return; }
            setLink(location.href);
            setReady(false);
        };
        window.addEventListener("hashchange", receive);
        return () => window.removeEventListener("hashchange", receive);
    }, []);
    if (ready) return <Fragment key={generation}>{children}</Fragment>;
    let target: ReturnType<typeof parseConnectionLink> | null = null;
    try { target = parseConnectionLink(link); } catch { /* 입력 중에는 오류를 표시하지 않는다. */ }
    return <main className="login">
        <form aria-label="암호화 서버 연결" onSubmit={(event) => {
            event.preventDefault();
            try {
                const parsed = parseConnectionLink(link);
                const previous = connection();
                // Pages origin의 기존 초안·cache를 다른 서버에 붙이지 않는다.
                if (previous && (previous.endpoint !== parsed.connection.endpoint || previous.key !== parsed.connection.key)) {
                    throw new Error("등록된 서버와 키가 다릅니다. 소유자에게 확인하고 다른 서버는 별도 브라우저 프로필에서 연결하세요.");
                }
                configureConnection(parsed.connection);
                const hash = parsed.code ? new URL(pairingLink(location.origin, parsed.code)).hash : "";
                history.replaceState(history.state, "", location.pathname + location.search + hash);
                setReady(true);
            } catch (cause) { setError(cause instanceof Error ? cause.message : "연결 정보를 저장하지 못했습니다."); }
        }}>
            <h1>Grove 연결</h1>
            <label>서버 연결 링크<input value={link} onChange={(event) => { setLink(event.target.value); setError(null); }} autoComplete="off" spellCheck={false} required /></label>
            <label>연결 QR 사진<input type="file" accept="image/*" capture="environment" onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void scanPairingImage(file).then(setLink).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "QR 이미지를 읽지 못했습니다.");
                });
            }} /></label>
            {target && <>
                <p>서버: <code className="host-address">{new URL(target.connection.endpoint).host}</code></p>
                <label>서버 공개키<input value={target.connection.key} readOnly /></label>
            </>}
            {error && <p className="err" role="alert">{error}</p>}
            <button type="submit" disabled={!target}>서버 확인 후 연결</button>
        </form>
    </main>;
}
