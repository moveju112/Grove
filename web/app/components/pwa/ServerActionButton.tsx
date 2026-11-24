import { usePendingAction } from "../../state/usePendingAction";
import { useServerBlockReason } from "./lifecycle";
import { Button, type ButtonProps } from "../../design/Button";

/** 버튼 표현만 공통 경계와 맞춘다. 실행 직전 검사는 기존 API guard가 담당한다. */
export function ServerActionButton({ disabled, title, ...props }: ButtonProps) {
    const reason = useServerBlockReason();
    return <Button {...props} disabled={disabled || !!reason} title={reason ?? title} aria-description={reason ?? props["aria-description"]} />;
}


export function PendingServerActionButton({ action, pendingLabel, children, disabled, ...props }: Omit<ButtonProps, "onClick"> & {
    action: () => Promise<unknown>; pendingLabel: string;
}) {
    const { busy, run } = usePendingAction();
    return <ServerActionButton {...props} disabled={busy || disabled} aria-busy={busy} onClick={() => void run(action)}>
        {busy ? pendingLabel : children}
    </ServerActionButton>;
}
