import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { useState } from "react";
import type { ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { HelpTip, SentenceText } from "./HelpTip";
import { DraftInput } from "../design/Fields";
import { useProfileDraft } from "./settings/useProfileDraft";
import { AutosaveStatus } from "./settings/AutosaveStatus";

export function ProfileContextPolicy({ profile }: { profile: ModelProfile }) {
    const supported = useCapability("context_auto_clear_v1");
    const [editing, setEditing] = useState(false);
    if (supported === false) return null;
    const minutes = (profile.options as Record<string, unknown>).auto_clear_minutes;
    return <Stack gap={2} role="group" aria-label={`${profile.name} context 정책`} data-testid="profile-context-policy">
        <Text type="supporting" color="secondary">idle context: {minutes == null ? "범위별 설정 상속" : minutes === 0 ? "시간 제한 없이 유지" : `${minutes}분 뒤 다음 요청에서 초기화`}</Text>
        {editing ? <ContextEditor profile={profile} /> : <Button type="button" variant="secondary" density="compact" onClick={() => setEditing(true)}>context 정책 설정</Button>}
    </Stack>;
}

function ContextEditor({ profile }: { profile: ModelProfile }) {
    const state = useProfileDraft("context", profile, (profile) => ({
        options: profile.options as Record<string, unknown>, minutes: String((profile.options as Record<string, unknown>).auto_clear_minutes ?? ""),
    }), (draft) => {
        const options = { ...draft.options };
        if (draft.minutes === "") delete options.auto_clear_minutes;
        else options.auto_clear_minutes = Number(draft.minutes);
        return options;
    }, ["context_auto_clear_v1"]);
    return <Stack as="form" ref={state.formRef} onInputCapture={state.validate} onSubmit={(event) => event.preventDefault()} gap={2}>
        <Stack direction="horizontal" align="center" gap={1}>idle context 초기화(분) <HelpTip label="idle context 초기화 도움말">
            <SentenceText text="다음 사용자 요청부터 적용합니다. 빈 값은 범위별 설정 상속, 0은 초기화 없음입니다. 화면 이력·파일을 삭제하거나 요약하지 않습니다." />
        </HelpTip></Stack>
        <DraftInput type="number" min={0} max={525600} step={1} label="프로필 idle context 초기화(분)" isLabelHidden value={state.value.minutes}
            onChange={(minutes) => state.change({ ...state.value, minutes })} onBlur={state.blur} />
        <AutosaveStatus state={state} />
    </Stack>;
}
