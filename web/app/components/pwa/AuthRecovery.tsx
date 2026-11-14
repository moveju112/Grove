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
            <h1>다시 로그인하세요</h1>
            <div className="recovery-lead">
                <SentenceText text="기존 초안을 삭제하지 않았습니다. 원래 계정으로 로그인하면 다시 열 수 있습니다." />
                <HelpTip label="초안을 숨긴 이유">
                    <SentenceText text="다른 사용자의 초안이 보이지 않도록 로그인 전에는 초안 목록과 내용을 표시하지 않습니다. 저장소에서 이미 삭제된 초안은 복구할 수 없습니다." />
                </HelpTip>
            </div>
            <p className="muted"><SentenceText text="보내지 못한 요청은 자동으로 다시 보내지 않습니다. 사이트 데이터 삭제·재설치는 복구 방법이 아닙니다." /></p>
            {reason && <p role="status"><SentenceText text={reason} /></p>}
            {attempted && !reason && <p role="status"><SentenceText text="로그인을 복원하지 못했습니다. 로그인 화면에서 다시 인증하세요." /></p>}
            <button disabled={busy || !state.online || state.protocol !== null} onClick={() => void retry()}>
                {busy ? "로그인 확인 중…" : "연결·로그인 다시 확인"}
            </button>
        </section>
    </main>;
}
