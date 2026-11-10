import { useEffect, useState } from "react";

/// `<details>` 열림 상태: 조건(예: 실행 중 항목 있음)이 참이 되면 열고, 거짓이 되어도 닫지 않는다.
/// open 속성을 조건으로만 계산하면 조건이 끝날 때 React가 속성을 지워 사용자가 연 패널이 닫힌다.
export function useAutoOpen(trigger: boolean): { open: boolean; onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => void } {
    const [open, setOpen] = useState(trigger);
    useEffect(() => {
        if (trigger) setOpen(true);
    }, [trigger]);
    return { open, onToggle: (e) => setOpen(e.currentTarget.open) };
}
