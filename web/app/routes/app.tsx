import { useEffect, useState } from "react";
import { onAuthChange, refresh } from "../api/client";
import { Login } from "../components/Login";
import { Workspace } from "../components/Workspace";
import { ProtocolBanner, UpdateBanner, registerServiceWorker } from "../components/pwa";
import { PairingLogin } from "../components/Pairing";
import { AuthRecovery } from "../components/pwa/AuthRecovery";
import { checkCompatibility, lifecycleSnapshot, serverBlockReason, useLifecycle } from "../components/pwa/lifecycle";
import { EncryptedConnection } from "../components/EncryptedConnection";

export default function AppRoute() {
    return <EncryptedConnection><ConnectedApp /></EncryptedConnection>;
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
            if (!stopped) setState(s ? "in" : "out");
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
            <ProtocolBanner />
            <UpdateBanner />
            {pairing ? <PairingLogin key={pairing} initialLink={pairing} checking={state === "checking"} onDone={() => setPairing(null)} onCancel={() => {
                setPairing(null);
            }} /> : state !== "in" && state !== "checking" && (deferredAuth || serverBlockReason(lifecycle)) ? <AuthRecovery recover={async () => {
                const session = await refresh();
                setState(session ? "in" : "out");
                if (!serverBlockReason(lifecycleSnapshot())) setDeferredAuth(false);
            }} /> : state === "checking" ? <div className="boot">연결 확인 중…</div> : state === "in" ? <Workspace /> : <Login />}
        </>
    );
}
