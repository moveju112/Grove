// 빌드 시 SPA 루트(index.html)를 미리 렌더링할 때만 쓰는 진입점. 운영 SSR 서버는 없다.
// renderToString을 쓰면 React Router의 hydration 데이터 stream이 닫히지 않아 클라이언트가 무한 대기한다.
// 따라서 stream 렌더링을 끝까지(allReady) 기다린 뒤 응답한다.
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";

export default async function handleRequest(request: Request, status: number, headers: Headers, context: EntryContext) {
    let code = status;
    const body = await renderToReadableStream(<ServerRouter context={context} url={request.url} />, {
        onError(error: unknown) {
            code = 500;
            console.error(error);
        },
    });
    await body.allReady;
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(body, { status: code, headers });
}
