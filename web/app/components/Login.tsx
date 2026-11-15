import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { useState } from "react";
import { lastAuthEnd, login } from "../api/client";
import { deviceName } from "../state/device";
import { Hosts } from "./Hosts";
import { Icon } from "./icons";
import { PairingLogin } from "./Pairing";
import { RevealText } from "./RevealText";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { HelpTip, SentenceText } from "./HelpTip";
import { Stack } from "@astryxdesign/core/Stack";
import { Center } from "@astryxdesign/core/Center";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "../design/Button";
import { TextInput } from "@astryxdesign/core/TextInput";

export function Login() {
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [pairing, setPairing] = useState(false);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await login(token.trim(), deviceName());
            setToken("");
        } catch (err) {
            setError(err instanceof Error ? err.message : "서버에 연결할 수 없습니다");
        } finally {
            setBusy(false);
        }
    };
    if (pairing) return <PairingLogin onDone={() => setPairing(false)} onCancel={() => setPairing(false)} />;
    return (
        <Center role="main" minHeight="100dvh" padding={4}>
            <Card width={392} maxWidth="100%" padding={8}>
            <Stack as="form" gap={4} onSubmit={submit} aria-label="로그인">
                <GroveText type="inherit" color="brand" aria-hidden="true" data-testid="brand-mark"><Icon name="sprout" size={28} /></GroveText>
                <GroveHeading level={1} color="inherit"><RevealText text="Grove" /></GroveHeading>
                <Hosts />
                {lastAuthEnd() === "expired" && (
                    <GroveText as="p" display="block" type="inherit" color="warning" role="status" data-testid="auth-expired">
                        <SentenceText text="로그인이 만료되었거나 이 기기 토큰이 폐기되었습니다. 다시 로그인하세요." />
                    </GroveText>
                )}
                <GroveText as="p" display="block" type="inherit" color="inherit">서버의 소유자 토큰(<code>grove token</code>) 또는 기기 토큰을 입력하세요.</GroveText>
                <Stack direction="horizontal" align="center" gap={1}>
                    <GroveText type="inherit" color="inherit">토큰</GroveText>
                    <HelpTip label="보관 방식 도움말"><SentenceText text="토큰은 이 브라우저에 저장하지 않습니다." /></HelpTip>
                </Stack>
                <TextInput label="토큰" isLabelHidden id="login-token" type="password" autoComplete="off"
                    value={token} onChange={setToken} placeholder="grv_…" isRequired />
                {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert"><SentenceText text={error} /></GroveText>}
                <ServerActionButton type="submit" disabled={busy || !token.trim()}>
                    {busy ? "확인 중…" : "로그인"}
                </ServerActionButton>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setPairing(true)}>페어링 링크·QR로 등록</Button>
            </Stack>
            </Card>
        </Center>
    );
}
