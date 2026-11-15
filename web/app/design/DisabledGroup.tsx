import { Stack } from "@astryxdesign/core/Stack";
import type { FieldsetHTMLAttributes } from "react";
import * as stylex from "@stylexjs/stylex";

// disabled의 하위 폼 제어 차단은 native fieldset이 맡는다. Stack에는 테두리 reset 속성이 없다.
const styles = stylex.create({
    reset: { borderWidth: 0, margin: 0, padding: 0, minWidth: 0 },
});

export function DisabledGroup(props: FieldsetHTMLAttributes<HTMLFieldSetElement>) {
    return <Stack as="fieldset" gap={2} xstyle={styles.reset} {...props} />;
}
