// 같은 조작을 연속으로 눌러도 진행 중인 요청은 한 번만 실행한다.
import { useRef, useState } from "react";

export function usePendingAction() {
    const active = useRef(false);
    const [busy, setBusy] = useState(false);
    const run = async <T>(action: () => Promise<T>) => {
        if (active.current) return;
        active.current = true;
        setBusy(true);
        try { return await action(); }
        finally { active.current = false; setBusy(false); }
    };
    return { busy, run };
}
