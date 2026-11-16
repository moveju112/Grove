// 원문 근거의 정확한 메시지로 이동한다. 탭 배치(서버 검증 대상)에 넣지 않는 일회성 화면 요청이다.
import { useEffect, useState } from "react";

const pending = new Map<string, number>();
const subs = new Set<() => void>();

/// 이 대화를 열거나(이미 열려 있으면 그 화면에서) 해당 seq 메시지로 이동하게 한다.
export function requestFocus(sessionId: string, seq: number) {
    pending.set(sessionId, seq);
    for (const f of subs) f();
}

/// 이 대화에 대한 이동 요청과, 처리 후 지우는 함수.
export function useFocusRequest(sessionId: string): [number | null, () => void] {
    const [seq, setSeq] = useState<number | null>(() => pending.get(sessionId) ?? null);
    useEffect(() => {
        const f = () => setSeq(pending.get(sessionId) ?? null);
        subs.add(f);
        f();
        return () => {
            subs.delete(f);
        };
    }, [sessionId]);
    return [
        seq,
        () => {
            pending.delete(sessionId);
            setSeq(null);
        },
    ];
}
