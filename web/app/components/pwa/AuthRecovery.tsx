import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Center } from "@astryxdesign/core/Center";
import { Card } from "@astryxdesign/core/Card";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useState } from "react";
import { checkCompatibility, serverBlockReason, useLifecycle } from "./lifecycle";
import { SentenceText } from "../HelpTip";
import { LoadingBar } from "../LoadingScreen";
import { needsAuthRecovery } from "../../api/client";

/** 인증 전에는 전송 확인 기록·대화 목록을 읽지 않는다. 복구는 명시적인 인증 확인만 한다. */
export function AuthRecovery({ recover }: { recover: () => Promise<void> }) {
    const state = useLifecycle();
    const [busy, setBusy] = useState(false);
    const [attempted, setAttempted] = useState(false);
    const reason = serverBlockReason(state);
    const unavailable = needsAuthRecovery();
    const retry = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await checkCompatibility();
            await recover();
            setAttempted(true);
        } finally {
            setBusy(false);
        }
    };
    return <Center role="main" minHeight="100dvh" padding={4} data-testid="auth-recovery">
        {busy && <LoadingBar label="로그인 확인 중" />}
        <Card maxWidth={448} padding={6}>
        <GroveStack as="section" gap={3} aria-label="안전한 로그인 복구">
            <GroveHeading level={1} color="inherit">{unavailable ? "로그인을 확인할 수 없어요" : "다시 로그인하세요"}</GroveHeading>
            <GroveText as="p" display="block" type="inherit" color="secondary"><SentenceText text="요청은 자동 재전송하지 않으며, 원래 계정으로 로그인한 뒤 대화 기록에서 결과를 확인하세요." /></GroveText>
            {reason && <GroveText as="p" display="block" type="inherit" color="inherit" role="status"><SentenceText text={reason} /></GroveText>}
            {attempted && !reason && <GroveText as="p" display="block" type="inherit" color="inherit" role="status"><SentenceText text={unavailable ? "서버 연결을 확인하지 못했어요. 잠시 후 다시 확인하세요." : "로그인 복원에 실패했으니 로그인 화면에서 다시 인증하세요."} /></GroveText>}
            <GroveButton disabled={busy || !state.online || state.protocol !== null} onClick={() => void retry()}>
                {busy ? "로그인 확인 중…" : "연결·로그인 다시 확인"}
            </GroveButton>
        </GroveStack>
        </Card>
    </Center>;
}
