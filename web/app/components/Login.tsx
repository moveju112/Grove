import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { useState } from "react";
import { lastAuthEnd } from "../api/client";
import { Hosts } from "./Hosts";
import { Icon } from "./icons";
import { PairingLogin } from "./Pairing";
import { RevealText } from "./RevealText";
import { SentenceText } from "./HelpTip";
import { Stack } from "@astryxdesign/core/Stack";
import { Center } from "@astryxdesign/core/Center";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "../design/Button";

export function Login() {
    const [pairing, setPairing] = useState(false);
    if (pairing) return <PairingLogin onDone={() => setPairing(false)} onCancel={() => setPairing(false)} />;
    return (
        <Center role="main" minHeight="100dvh" padding={4}>
            <Card width={392} maxWidth="100%" padding={8}>
            <Stack gap={4} aria-label="로그인">
                <GroveText type="inherit" color="brand" aria-hidden="true" data-testid="brand-mark"><Icon name="sprout" size={28} /></GroveText>
                <GroveHeading level={1} color="inherit"><RevealText text="Grove" /></GroveHeading>
                <Hosts />
                {lastAuthEnd() === "expired" && (
                    <GroveText as="p" display="block" type="inherit" color="warning" role="status" data-testid="auth-expired">
                        <SentenceText text="로그인이 만료됐거나 이 기기의 접근이 해제됐어요. 다시 등록해 주세요." />
                    </GroveText>
                )}
                <GroveText as="p" display="block" type="inherit" color="inherit">페어링 링크 또는 QR과 비밀번호로 기기를 등록하세요.</GroveText>
                <Button type="button" onClick={() => setPairing(true)}>페어링 링크·QR로 등록</Button>
                <GroveText as="p" display="block" type="supporting" color="secondary">첫 기기는 서버 터미널에서 <code>grove pairing create</code>로 링크를 발급하세요.</GroveText>
            </Stack>
            </Card>
        </Center>
    );
}
