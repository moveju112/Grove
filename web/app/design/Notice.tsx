import { Card, type CardVariant } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import type { HTMLAttributes, ReactNode } from "react";

/** 동작 버튼이 포함된 접수·결과 불명 안내. 메시지와 버튼을 같은 접근성 그룹에 둔다. */
export function Notice({ tone = "muted", children, ...props }: HTMLAttributes<HTMLDivElement> & {
    tone?: CardVariant; children: ReactNode;
}) {
    return <Card variant={tone} padding={2} {...props}><Stack gap={2}>{children}</Stack></Card>;
}
