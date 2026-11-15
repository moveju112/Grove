import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from "react-router";
import { useEffect } from "react";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./design/grove.css";
import "./design/grove-soft.css";
import "./app.css";
import { DesignProvider } from "./design/DesignProvider";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "./design/Button";
import { applyPrefs, loadPrefs } from "./state/device";
import { installAuthCleanup } from "./state/cleanup";
import { deployment } from "./deployment";
import { LifecycleBanner } from "./components/pwa/LifecycleBanner";
import { LoadingScreen } from "./components/LoadingScreen";

// 로그인 화면을 포함해 첫 화면부터 이 기기 테마를 적용한다(빌드 시 prerender에서는 document가 없다).
if (typeof document !== "undefined") {
    applyPrefs(loadPrefs());
    installAuthCleanup();
}

export function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="ko" data-astryx-theme="grove">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
                <meta name="theme-color" content="#f7f7f8" />
                <link rel="manifest" href={deployment.manifest} />
                <link rel="icon" href={deployment.icon} type="image/svg+xml" />
                <link rel="apple-touch-icon" href={deployment.appleTouchIcon} />
                <title>Grove</title>
                <Meta />
                <Links />
            </head>
            <body>
                <DesignProvider>{children}</DesignProvider>
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
    return <Stack className="pwa-shell"><LifecycleBanner /><Outlet /></Stack>;
}

// 빌드 시 루트 렌더링 동안 보이는 화면(브라우저 API는 여기서 쓰지 않는다).
export function HydrateFallback() {
    return <LoadingScreen label="Grove 불러오는 중…" />;
}

export function ErrorBoundary() {
    const err = useRouteError();
    const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : "알 수 없는 오류";
    return (
        <Stack className="boot error" role="alert">
            <Heading level={1} color="inherit">화면 오류</Heading>
            <Text as="p" display="block" type="inherit" color="inherit">{msg}</Text>
            <Button onClick={() => location.reload()}>다시 불러오기</Button>
        </Stack>
    );
}
