import * as stylex from "@stylexjs/stylex";

export const contentStyles = stylex.create({
    // Item의 목록 label도 답변 본문의 행간을 사용한다. 앱의 탐색 목록에는 적용하지 않는다.
    markdown: { lineHeight: 1.5, "--text-body-leading": "1.5" },
    inlineLink: { minHeight: 0, fontSize: "inherit", lineHeight: "inherit", verticalAlign: "baseline" },
    // Text의 wrap 속성은 입력 원문의 개행 보존을 제공하지 않는다.
    plainText: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
    quote: {
        borderInlineStartWidth: 3,
        borderInlineStartStyle: "solid",
        borderInlineStartColor: "var(--line)",
        margin: 0,
        color: "var(--muted)",
    },
    selectable: { userSelect: "all" },
    // QR과 원문 이미지·텍스트는 전문 renderer의 native 출력이다.
    qr: { display: "block", maxWidth: "100%", height: "auto" },
    previewImage: { maxWidth: "100%", maxHeight: "70dvh", objectFit: "contain" },
    attachmentImage: { maxWidth: "min(100%, 360px)", maxHeight: 280, objectFit: "contain" },
    attachmentText: { maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
    // 외부 문서 격리용 iframe은 Astryx에 대응 표면이 없다.
    artifactFrame: {
        width: "100%",
        height: "min(32em, 65dvh)",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "var(--line)",
        backgroundColor: "white",
    },
});
