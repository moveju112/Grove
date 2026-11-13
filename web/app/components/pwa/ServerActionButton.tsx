import type { ButtonHTMLAttributes } from "react";
import { useServerBlockReason } from "./lifecycle";

/** 버튼 표현만 공통 경계와 맞춘다. 실행 직전 검사는 기존 API guard가 담당한다. */
export function ServerActionButton({ disabled, title, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
    const reason = useServerBlockReason();
    return <button {...props} disabled={disabled || !!reason} title={reason ?? title} aria-description={reason ?? props["aria-description"]} />;
}
