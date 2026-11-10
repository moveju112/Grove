import { useEffect, useState } from "react";
import { onAuthChange, refresh } from "../api/client";
import { Login } from "../components/Login";
import { Workspace } from "../components/Workspace";
import { ProtocolBanner, UpdateBanner, registerServiceWorker } from "../components/pwa";

export default function AppRoute() {
    const [state, setState] = useState<"checking" | "in" | "out">("checking");
    useEffect(() => {
        const off = onAuthChange((s) => setState(s ? "in" : "out"));
        // 새로고침 후 HttpOnly 쿠키로 access token을 다시 받는다.
        void refresh().then((s) => setState(s ? "in" : "out"));
        registerServiceWorker();
        return () => {
            off();
        };
    }, []);
    return (
        <>
            <ProtocolBanner />
            <UpdateBanner />
            {state === "checking" ? <div className="boot">연결 확인 중…</div> : state === "in" ? <Workspace /> : <Login />}
        </>
    );
}
