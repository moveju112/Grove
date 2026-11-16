import { Text } from "@astryxdesign/core/Text";
import { Stack } from "@astryxdesign/core/Stack";
import { Button } from "../../design/Button";
import type { SaveSnapshot } from "../../state/autosave";

export function AutosaveStatus({ state, applies }: {
    state: SaveSnapshot<unknown> & { useRemote: () => void; applyMine: () => void; retry: () => void }; applies?: string;
}) {
    const failed = state.phase === "error" || state.phase === "conflict" || state.phase === "uncertain";
    return <>
        {state.dirty && <Text type="supporting" color="secondary" data-settings-unsaved="true">저장 안 됨</Text>}
        {state.phase !== "idle" && <Text as="p" display="block" type="supporting" color={failed ? "error" : "secondary"}
            data-settings-issue={failed ? "error" : undefined} role="status">
            {state.phase === "saving" ? "저장 중…" : state.phase === "saved" ? `저장됨${applies ? ` · ${applies}` : ""}`
                : state.phase === "conflict" ? "다른 기기에서 먼저 바뀌었어요. 내 입력은 보존했어요."
                : state.phase === "uncertain" ? "저장 결과를 확인하지 못했어요. 새 변경을 보내기 전에 원래 요청을 확인하세요."
                : `저장 실패(기존 값 유지): ${state.message}`}
        </Text>}
        {state.phase === "conflict" && <Stack direction="horizontal" wrap="wrap" gap={2}>
            <Button variant="secondary" onClick={state.useRemote}>최신 값 사용</Button>
            <Button variant="secondary" disabled={!state.canRebase} onClick={state.applyMine}>내 수정 적용</Button>
        </Stack>}
        {state.phase === "uncertain" && <Button variant="secondary" onClick={state.retry}>요청 결과 확인</Button>}
        {state.phase === "error" && state.canRetry && <Button variant="secondary" onClick={state.retry}>다시 시도</Button>}
    </>;
}
