import { useState } from "react";
import { checkCompatibility, serverBlockReason, useLifecycle } from "./lifecycle";

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
        <section aria-label="안전한 로그인 복구">
            <h1>연결 후 로그인 복구가 필요합니다</h1>
            <p>이 화면에는 확인된 인증·대화 정보가 없어 기존 초안을 안전하게 열 수 없습니다. 다른 사용자의 초안을 노출하지 않도록 로그인 전에는 로컬 초안 목록과 내용을 표시하지 않습니다.</p>
            <p>기존 초안을 삭제하지 않았습니다. 같은 서버·브라우저에서 연결을 복구하고 원래 계정으로 인증한 뒤 대화를 다시 여세요. 저장소에서 이미 삭제된 초안은 복구할 수 없습니다.</p>
            <p>서버 작업이나 결과 불명 요청을 자동으로 다시 보내지 않습니다. 다른 탭의 입력과 실행 중인 작업은 그대로 두세요. 사이트 데이터 삭제·재설치는 복구 방법이 아닙니다.</p>
            {reason && <p role="status">{reason}</p>}
            {attempted && !reason && <p role="status">로그인을 복원하지 못했습니다. 온라인 로그인 화면에서 다시 인증하세요.</p>}
            <button disabled={busy || !state.online || state.protocol !== null} onClick={() => void retry()}>
                {busy ? "로그인 확인 중…" : "연결·로그인 다시 확인"}
            </button>
        </section>
    </main>;
}
