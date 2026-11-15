import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Center } from "@astryxdesign/core/Center";
import { noticeStyles } from "../design/notices.stylex";

/** 화면 상단에 고정되는 진행 표시줄. 기다리는 동안 기존 화면과 입력은 그대로 둔다. */
export function LoadingBar({ label }: { label: string }) {
    return <GroveStack gap={0} xstyle={noticeStyles.loading} data-testid="loading-bar">
        <ProgressBar isIndeterminate isLabelHidden label={label} variant="neutral" />
    </GroveStack>;
}

/** 표시할 화면이 아직 없을 때 쓰는 전체 로딩 화면. */
export function LoadingScreen({ label }: { label: string }) {
    return <Center minHeight="100dvh" padding={8} aria-busy="true">
        <LoadingBar label={label} />
        <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{label}</GroveText>
    </Center>;
}
