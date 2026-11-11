import { useEffect, useState } from "react";
import { onAuthChange, refresh } from "../api/client";
import { Login } from "../components/Login";
import { Workspace } from "../components/Workspace";
import { ProtocolBanner, UpdateBanner, registerServiceWorker } from "../components/pwa";
import { PairingLogin } from "../components/Pairing";

export default function AppRoute() {
    const [state, setState] = useState<"checking" | "in" | "out">("checking");
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
        void refresh().then((s) => setState(s ? "in" : "out"));
        window.addEventListener("hashchange", receivePairing);
        registerServiceWorker();
        return () => {
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
            }} /> : state === "checking" ? <div className="boot">연결 확인 중…</div> : state === "in" ? <Workspace /> : <Login />}
        </>
    );
}
