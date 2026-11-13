import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from "react-router";
import { useEffect } from "react";
import "./app.css";
import { applyPrefs, loadPrefs } from "./state/device";
import { installAuthCleanup } from "./state/cleanup";
import { deployment } from "./deployment";
import { LifecycleBanner } from "./components/pwa/LifecycleBanner";

// 로그인 화면을 포함해 첫 화면부터 이 기기 테마를 적용한다(빌드 시 prerender에서는 document가 없다).
if (typeof document !== "undefined") {
    applyPrefs(loadPrefs());
    installAuthCleanup();
}

export function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="ko">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
                <meta name="theme-color" content="#2f6b3f" />
                <link rel="manifest" href={deployment.manifest} />
                <link rel="icon" href={deployment.icon} type="image/svg+xml" />
                <link rel="apple-touch-icon" href={deployment.appleTouchIcon} />
                <title>Grove</title>
                <Meta />
                <Links />
            </head>
            <body>
                {children}
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    );
}

export default function Root() {
    // hydration 완료 표시. 그 전의 입력은 React가 다시 그리며 지워질 수 있다.
    useEffect(() => {
        document.documentElement.dataset.hydrated = "true";
    }, []);
    return <div className="pwa-shell"><LifecycleBanner /><Outlet /></div>;
}

// 빌드 시 루트 렌더링 동안 보이는 화면(브라우저 API는 여기서 쓰지 않는다).
export function HydrateFallback() {
    return <div className="boot">Grove 불러오는 중…</div>;
}

export function ErrorBoundary() {
    const err = useRouteError();
    const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : "알 수 없는 오류";
    return (
        <div className="boot error" role="alert">
            <h1>화면 오류</h1>
            <p>{msg}</p>
            <button onClick={() => location.reload()}>다시 불러오기</button>
        </div>
    );
}
