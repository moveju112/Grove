import { useState } from "react";
import { ApiError, lastAuthEnd, login } from "../api/client";
import { deviceName } from "../state/device";
import { Hosts } from "./Hosts";
import { PairingLogin } from "./Pairing";
import { ServerActionButton } from "./pwa/ServerActionButton";

export function Login() {
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [pairing, setPairing] = useState(false);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await login(token.trim(), deviceName());
            setToken("");
        } catch (err) {
            setError(err instanceof ApiError ? err.message : "서버에 연결할 수 없습니다");
        } finally {
            setBusy(false);
        }
    };
    if (pairing) return <PairingLogin onDone={() => setPairing(false)} onCancel={() => setPairing(false)} />;
    return (
        <main className="login">
            <form onSubmit={submit} aria-label="로그인">
                <img src="/icon.svg" alt="" width={56} height={56} />
                <h1>Grove</h1>
                <Hosts />
                {lastAuthEnd() === "expired" && (
                    <p className="warn" role="status" data-testid="auth-expired">
                        로그인이 만료되었거나 이 기기 토큰이 폐기되었습니다. 다시 로그인하세요.
                    </p>
                )}
                <p>서버의 소유자 토큰(<code>grove token</code>) 또는 기기 토큰을 입력하세요. 토큰은 이 브라우저에 저장하지 않습니다.</p>
                <label>
                    토큰
                    <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="grv_…" required />
                </label>
                {error && <p className="err" role="alert">{error}</p>}
                <ServerActionButton type="submit" disabled={busy || !token.trim()}>
                    {busy ? "확인 중…" : "로그인"}
                </ServerActionButton>
                <button type="button" className="ghost" disabled={busy} onClick={() => setPairing(true)}>페어링 링크·QR로 등록</button>
            </form>
        </main>
    );
}
