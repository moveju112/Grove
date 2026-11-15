import { Stack } from "@astryxdesign/core/Stack";
import { Center } from "@astryxdesign/core/Center";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { configureConnection, connection, parseConnectionLink } from "../api/transport";
import { pairingLink, scanPairingImage } from "../state/pairing";
import { TextInput, FileInput } from "../design/Fields";

/** 이미 신뢰한 서버와 같은 연결 링크는 다시 확인하지 않고 페어링 hash로 바꾼다. */
function adoptKnownLink(): boolean {
    if (!location.hash.startsWith("#connect=")) return false;
    try {
        const parsed = parseConnectionLink(location.href);
        const current = connection();
        if (current?.endpoint !== parsed.connection.endpoint || current.key !== parsed.connection.key) return false;
        const hash = parsed.code ? new URL(pairingLink(location.origin, parsed.code)).hash : "";
        history.replaceState(history.state, "", location.pathname + location.search + hash);
        return true;
    } catch { return false; }
}

/// Pages의 bootstrap 단계. 신뢰할 링크의 pin을 확인하기 전에는 API·토큰을 보내지 않는다.
export function EncryptedConnection({ children }: { children: ReactNode }) {
    const [link, setLink] = useState(() => location.hash.startsWith("#connect=") ? location.href : "");
    const [ready, setReady] = useState(() => {
        if (location.hash.startsWith("#connect=")) return adoptKnownLink();
        try { return !!connection() || location.hostname !== "grove.choondoggy.com"; }
        catch { return false; }
    });
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        // 앱을 연 채 주소창의 연결 링크로 이동하면 문서가 다시 로드되지 않으므로 직접 처리한다.
        const receive = () => {
            if (!location.hash.startsWith("#connect=")) return;
            setError(null);
            if (adoptKnownLink()) { setReady(true); setGeneration((value) => value + 1); return; }
            setLink(location.href);
            setReady(false);
        };
        window.addEventListener("hashchange", receive);
        return () => window.removeEventListener("hashchange", receive);
    }, []);
    if (ready) return <Fragment key={generation}>{children}</Fragment>;
    let target: ReturnType<typeof parseConnectionLink> | null = null;
    try { target = parseConnectionLink(link); } catch { /* 입력 중에는 오류를 표시하지 않는다. */ }
    return <Center role="main" minHeight="100dvh" padding={4}>
        <Card width={392} maxWidth="100%" padding={8}>
        <Stack as="form" gap={4} aria-label="암호화 서버 연결" onSubmit={(event) => {
            event.preventDefault();
            try {
                const parsed = parseConnectionLink(link);
                const previous = connection();
                // Pages origin의 기존 초안·cache를 다른 서버에 붙이지 않는다.
                if (previous && (previous.endpoint !== parsed.connection.endpoint || previous.key !== parsed.connection.key)) {
                    throw new Error("등록된 서버와 키가 다릅니다. 소유자에게 확인하고 다른 서버는 별도 브라우저 프로필에서 연결하세요.");
                }
                configureConnection(parsed.connection);
                const hash = parsed.code ? new URL(pairingLink(location.origin, parsed.code)).hash : "";
                history.replaceState(history.state, "", location.pathname + location.search + hash);
                setReady(true);
            } catch (cause) { setError(cause instanceof Error ? cause.message : "연결 정보를 저장하지 못했습니다."); }
        }}>
            <GroveHeading level={1} color="inherit">Grove 연결</GroveHeading>
            <TextInput label="서버 연결 링크" value={link} onChange={(value) => { setLink(value); setError(null); }} autoComplete="off" hasSpellCheck={false} isRequired />
            <FileInput label="연결 QR 사진" accept="image/*" capture="environment" value={null} onChange={(files) => {
                const file = Array.isArray(files) ? files[0] : files;
                if (file) void scanPairingImage(file).then(setLink).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "QR 이미지를 읽지 못했습니다.");
                });
            }} />
            {target && <>
                <GroveText as="p" display="block" type="inherit" color="inherit">서버: <Code>{new URL(target.connection.endpoint).host}</Code></GroveText>
                <TextInput label="서버 공개키" value={target.connection.key} isReadOnly />
            </>}
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
            <GroveButton type="submit" disabled={!target}>서버 확인 후 연결</GroveButton>
        </Stack>
        </Card>
    </Center>;
}
