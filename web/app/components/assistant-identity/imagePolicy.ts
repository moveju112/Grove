// BotsPanel과 같은 계약: 인증된 rawGet으로 받은 PNG의 object URL만 표시한다.
// 일반 URL은 같은 origin이어도 인증 헤더를 보낼 수 없으므로 직접 img.src에 넣지 않는다.
export function safeAssistantImageUrl(imageUrl: string | null | undefined, origin: string): string | null {
    if (!imageUrl || !imageUrl.startsWith(`blob:${origin}/`)) return null;
    try {
        const page = new URL(origin);
        const image = new URL(imageUrl.slice("blob:".length));
        if (!["https:", "http:"].includes(page.protocol) || page.origin !== origin) return null;
        if (image.origin !== origin || image.username || image.password || image.search || image.hash) return null;
        if (image.href !== imageUrl.slice("blob:".length)) return null;
        // createObjectURL의 opaque ID 하나만 받는다. 다른 경로·query로 확장하지 않는다.
        if (!/^\/[A-Za-z0-9-]+$/.test(image.pathname)) return null;
        return imageUrl;
    } catch {
        return null;
    }
}
