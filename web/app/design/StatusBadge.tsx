import { Badge, type BadgeProps } from "@astryxdesign/core/Badge";
import type { ReactNode } from "react";

type Props = Omit<BadgeProps, "label" | "variant"> & { status?: string; children: ReactNode };

/** 기존 상태 의미를 Astryx의 의미 색으로 연결한다. 정상 상태에 성공 색을 덧붙이지 않는다. */
export function StatusBadge({ status, children, ...props }: Props) {
    const variant = status === "failed" || status === "denied" ? "error"
        : status === "awaiting_approval" || status === "awaiting_input" || status === "unknown_result" || status === "unknown"
          ? "warning" : "neutral";
    return <Badge {...props} variant={variant} label={children} />;
}
