import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantIdentity, type AssistantIdentityProps } from "./index";
import { safeAssistantImageUrl } from "./imagePolicy";

const ORIGIN = "https://grove.example.test";
const IMAGE = `blob:${ORIGIN}/bde5dd36-87ab-4ad5-95a0-7de486031633`;
const render = (props: AssistantIdentityProps) => renderToStaticMarkup(createElement(AssistantIdentity, props));

afterEach(() => vi.unstubAllGlobals());

describe("assistant 사진 정책", () => {
    it.each(["https://grove.example.test", "http://127.0.0.1:17741", "https://grove.example.test:8443"])(
        "%s에서 만든 object URL을 허용한다",
        (origin) => {
            const image = `blob:${origin}/bde5dd36-87ab-4ad5-95a0-7de486031633`;
            expect(safeAssistantImageUrl(image, origin)).toBe(image);
        },
    );

    it.each([
        null, undefined, "", " ", "javascript:alert(1)", "data:image/png;base64,AAAA",
        "file:///tmp/image.png", "/api/v1/bots/b/avatar", "/avatar.png",
        `${ORIGIN}/api/v1/bots/b/avatar`, "//grove.example.test/avatar.png",
        "https://tracker.example.test/pixel.png",
        "blob:https://tracker.example.test/id", "blob:http://grove.example.test/id",
        "blob:https://grove.example.test:8443/id", "blob:https://grove.example.test.evil.test/id",
        "blob:https://grove.example.test@evil.test/id", "blob:https://u:p@grove.example.test/id",
        "blob:null/id", "blob:blob:https://grove.example.test/id",
        ` ${IMAGE}`, `${IMAGE} `, `${IMAGE}?token=fixture`, `${IMAGE}#fragment`,
        `blob:${ORIGIN}/`, `blob:${ORIGIN}/a/b`, `blob:${ORIGIN}/a%2fb`,
        `blob:${ORIGIN}/a\\b`, `blob:${ORIGIN}/../id`,
    ])("허용하지 않은 URL은 img에 전달하지 않는다: %s", (image) => {
        expect(safeAssistantImageUrl(image, ORIGIN)).toBeNull();
    });

    it.each(["", "null", "file://", "https://grove.example.test/", "https://grove.example.test/path"])(
        "page origin이 유효하지 않으면 거절한다: %s",
        (origin) => expect(safeAssistantImageUrl(IMAGE, origin)).toBeNull(),
    );
});

describe("assistant 이름·아이콘 표시", () => {
    it("이름을 React 텍스트로 표시하고 이미지·HTML로 해석하지 않는다", () => {
        const html = render({ name: '<img src=x onerror="alert(1)"> & 봇' });
        expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 봇");
        expect(html).not.toContain("<img");
        expect(html).toContain('data-testid="assistant-default-icon"');
    });

    it.each(["", " \t\n "])("빈 이름은 기본 이름과 아이콘을 사용한다", (name) => {
        const html = render({ name });
        expect(html).toContain(">어시스턴트</span>");
        expect(html).toContain('data-image-state="fallback"');
    });

    it("visible 이름과 장식 이미지를 중복 낭독하지 않는다", () => {
        const html = render({ name: "그로브" });
        expect(html).toContain('data-testid="assistant-name">그로브</span>');
        expect(html).not.toContain("aria-label=");
        expect(html).toContain('aria-hidden="true"');
        expect(html).not.toContain('role="img"');
    });

    it.each(["작업 중…", "추론 중…", "응답 중…", "모델 · fixture-model"])(
        "이름과 보조 문구를 함께 표시한다: %s",
        (detail) => {
            const html = render({ name: "그로브", detail });
            expect(html).toContain('data-testid="assistant-name">그로브</span>');
            expect(html).toContain(`>${detail}</span>`);
            expect(html).not.toContain("aria-label=");
        },
    );

    it("보조 문구도 HTML로 해석하지 않고 avatar·decorative 용도에는 표시하지 않는다", () => {
        const detail = "<b>작업 중…</b>";
        expect(render({ name: "그로브", detail })).toContain("&lt;b&gt;작업 중…&lt;/b&gt;");
        for (const purpose of ["avatar", "decorative"] as const) {
            expect(render({ name: "그로브", detail, purpose })).not.toContain("작업 중");
        }
    });

    it("avatar 단독 용도는 이름이 있고 decorative 용도는 전체가 숨겨진다", () => {
        const avatar = render({ name: "사진 없는 봇", purpose: "avatar" });
        expect(avatar).toContain('role="img"');
        expect(avatar).toContain('aria-label="사진 없는 봇"');
        expect(avatar).not.toContain('data-testid="assistant-name"');
        const decorative = render({ name: "장식", purpose: "decorative" });
        expect(decorative).toContain('data-testid="assistant-identity"');
        expect(decorative).toContain('data-purpose="decorative"');
        expect(decorative).toContain('aria-hidden="true"');
        expect(decorative).not.toContain('role="img"');
        expect(decorative).not.toContain("aria-label=");
        expect(decorative).not.toContain('data-testid="assistant-name"');
    });

    it("허용된 사진을 받더라도 로딩 중에는 기본 아이콘을 유지한다", () => {
        vi.stubGlobal("window", { location: { origin: ORIGIN } });
        const html = render({ name: "그로브", imageUrl: IMAGE });
        expect(html).toContain(`src="${IMAGE}"`);
        expect(html).toContain('alt="" aria-hidden="true"');
        expect(html).toMatch(/referrerpolicy="no-referrer"/i);
        expect(html).toContain('data-image-state="loading"');
        expect(html).toContain('data-testid="assistant-default-icon"');
    });

    it.each(["https://tracker.example.test/pixel.png", `${ORIGIN}/api/v1/bots/b/avatar`, "javascript:alert(1)"])(
        "정책 위반 이미지는 요청할 markup도 만들지 않는다: %s",
        (imageUrl) => {
            vi.stubGlobal("window", { location: { origin: ORIGIN } });
            const html = render({ name: "그로브", imageUrl });
            expect(html).not.toContain("<img");
            expect(html).not.toContain(imageUrl);
            expect(html).toContain('data-image-state="fallback"');
        },
    );

    it.each(["sm", "md", "lg"] as const)("크기 %s에서도 긴 이름 전체를 보존한다", (size) => {
        const name = "아주긴어시스턴트이름".repeat(20);
        const html = render({ name, size });
        expect(html).toContain(`data-size="${size}"`);
        expect(html).toContain(`>${name}</span>`);
    });

    it("서버 렌더링은 browser origin을 추측하지 않고 기본 아이콘을 표시한다", () => {
        const html = render({ name: "그로브", imageUrl: IMAGE });
        expect(html).not.toContain("<img");
        expect(html).toContain('data-image-state="fallback"');
    });
});
