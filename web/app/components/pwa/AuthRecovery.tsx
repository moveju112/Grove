import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useState } from "react";
import { checkCompatibility, serverBlockReason, useLifecycle } from "./lifecycle";
import { HelpTip, SentenceText } from "../HelpTip";
import { LoadingBar } from "../LoadingScreen";

/** 인증 전에는 초안 키·본문·대화 목록을 읽지 않는다. 복구는 명시적인 인증 확인만 한다. */
export function AuthRecovery({ recover }: { recover: () => Promise<void> }) {
    const state = useLifecycle();
    const [busy, setBusy] = useState(false);
    const [attempted, setAttempted] = useState(false);
    const reason = serverBlockReason(state);
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
    return <main className="login" data-testid="auth-recovery">
        {busy && <LoadingBar label="로그인 확인 중" />}
        <section aria-label="안전한 로그인 복구">
            <GroveHeading level={1} color="inherit">다시 로그인하세요</GroveHeading>
            <div className="recovery-lead">
                <SentenceText text="기존 초안은 보존됐으며 원래 계정으로 로그인하면 다시 열 수 있습니다." />
                <HelpTip label="초안을 숨긴 이유">
                    <SentenceText text="다른 사용자의 초안이 보이지 않도록 로그인 전에는 초안 목록과 내용을 표시하지 않습니다. 저장소에서 이미 삭제된 초안은 복구할 수 없습니다." />
                </HelpTip>
            </div>
            <GroveText as="p" display="block" type="inherit" color="secondary"><SentenceText text="미전송 요청은 자동 재전송하지 않으며 사이트 데이터 삭제·재설치로 복구할 수 없습니다." /></GroveText>
            {reason && <GroveText as="p" display="block" type="inherit" color="inherit" role="status"><SentenceText text={reason} /></GroveText>}
            {attempted && !reason && <GroveText as="p" display="block" type="inherit" color="inherit" role="status"><SentenceText text="로그인 복원에 실패했으니 로그인 화면에서 다시 인증하세요." /></GroveText>}
            <GroveButton disabled={busy || !state.online || state.protocol !== null} onClick={() => void retry()}>
                {busy ? "로그인 확인 중…" : "연결·로그인 다시 확인"}
            </GroveButton>
        </section>
    </main>;
}
