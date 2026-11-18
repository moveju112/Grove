import { lazy, Suspense, useEffect, useState } from "react";
import { needsAuthRecovery, onAuthChange, refresh } from "../api/client";
import { Login } from "../components/Login";
import { registerServiceWorker } from "../components/pwa";
import { PairingLogin } from "../components/Pairing";
import { AuthRecovery } from "../components/pwa/AuthRecovery";
import { checkCompatibility, lifecycleSnapshot, serverBlockReason, useLifecycle } from "../components/pwa/lifecycle";
import { EncryptedConnection } from "../components/EncryptedConnection";
import { LoadingScreen } from "../components/LoadingScreen";
import { SetupGate } from "../components/SetupWizard";

const Workspace = lazy(async () => ({ default: (await import("../components/Workspace")).Workspace }));

export default function AppRoute() {
    return <EncryptedConnection><Suspense fallback={<LoadingScreen label="작업 공간 여는 중…" />}><ConnectedApp /></Suspense></EncryptedConnection>;
}

function ConnectedApp() {
    const [state, setState] = useState<"checking" | "in" | "out">("checking");
    const lifecycle = useLifecycle();
    const [deferredAuth, setDeferredAuth] = useState(false);
    const [pairing, setPairing] = useState<string | null>(() => location.hash.startsWith("#pairing=") ? location.href : null);
    useEffect(() => {
        const off = onAuthChange((s) => setState(s ? "in" : "out"));
        const receivePairing = () => {
            if (!location.hash.startsWith("#pairing=")) return;
            setPairing(location.href);
            history.replaceState(history.state, "", location.pathname + location.search);
        };
        receivePairing();
        // 새로고침 후 HttpOnly 쿠키로 access token을 다시 받는다.
        let stopped = false;
        void checkCompatibility().then(() => {
            if (stopped) return null;
            setDeferredAuth(!!serverBlockReason(lifecycleSnapshot()));
            return refresh();
        }).then((s) => {
            if (!stopped) {
                setDeferredAuth(needsAuthRecovery() || !!serverBlockReason(lifecycleSnapshot()));
                setState(s ? "in" : "out");
            }
        });
        window.addEventListener("hashchange", receivePairing);
        registerServiceWorker();
        return () => {
            stopped = true;
            off();
            window.removeEventListener("hashchange", receivePairing);
        };
    }, []);
    return (
        <>
            {pairing ? <PairingLogin key={pairing} initialLink={pairing} checking={state === "checking"} onDone={() => setPairing(null)} onCancel={() => {
                setPairing(null);
            }} /> : state !== "in" && lifecycle.online && lifecycle.connection === "checking" ? <LoadingScreen label="서버 연결 확인 중…" />
            : state !== "in" && state !== "checking" && (deferredAuth || serverBlockReason(lifecycle)) ? <AuthRecovery recover={async () => {
                const session = await refresh();
                setState(session ? "in" : "out");
                setDeferredAuth(needsAuthRecovery() || !!serverBlockReason(lifecycleSnapshot()));
            }} /> : state === "checking" ? <LoadingScreen label="로그인 확인 중…" /> : state === "in" ? <SetupGate><Workspace /></SetupGate> : <Login />}
        </>
    );
}
