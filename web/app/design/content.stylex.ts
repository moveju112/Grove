import * as stylex from "@stylexjs/stylex";

export const contentStyles = stylex.create({
    // Item의 목록 label도 답변 본문의 행간을 사용한다. 앱의 탐색 목록에는 적용하지 않는다.
    markdown: { lineHeight: 1.5, "--text-body-leading": "1.5" },
    // 열이 많은 표는 셀을 글자 한 자 폭으로 압축하지 않고 표 안에서 스크롤한다.
    // 가로 스크롤 영역의 내용은 max-content 폭이라 표 폭은 바깥 답변 폭(cqi)을 기준으로 정한다.
    markdownTableArea: { containerType: "inline-size" },
    markdownTable: (columns: number) => ({ width: "100cqi", minWidth: `${columns * 5}em` }),
    // Astryx 줄바꿈 셀의 max-width:0은 열을 균등 분배한다. 답변 표는 내용 길이에 따라 열 폭을 나눈다.
    markdownCell: { maxWidth: "none", overflowWrap: "anywhere" },
    inlineFileButton: {
        minHeight: 0,
        maxWidth: "100%",
        paddingInline: "var(--spacing-0-5)",
        borderWidth: 0,
        backgroundColor: { default: "transparent", ":hover": "transparent" },
        color: { default: "color-mix(in srgb, var(--split-line) 70%, var(--text))", ":hover": "var(--text)" },
        fontSize: "inherit",
        lineHeight: "inherit",
        verticalAlign: "baseline",
        whiteSpace: "normal",
        overflowWrap: "anywhere",
    },
    namedFileButton: { minHeight: { default: 26, "@media (pointer: coarse)": 44 } },
    fileIcon: { display: "inline-flex", verticalAlign: "-0.15em", marginInlineEnd: "var(--spacing-1)" },
    fileCaption: { fontWeight: 550, textDecorationLine: "underline", textDecorationThickness: "1px", textUnderlineOffset: "0.18em" },
    fileCode: { backgroundColor: "transparent", paddingInline: 0, paddingBlock: 0 },
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
    previewTitle: { flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" },
    previewBody: { minWidth: 0, overflow: "auto", maxHeight: "65dvh", overflowWrap: "anywhere" },
    previewDocument: {
        minHeight: "min(18em, 42dvh)",
        fontSize: "1.05em",
        "--text-heading-3-size": "1.8em",
        "--text-heading-4-size": "1.3em",
        "--text-heading-5-size": "1.12em",
    },
    previewImage: { maxWidth: "100%", maxHeight: "70dvh", objectFit: "contain" },
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
