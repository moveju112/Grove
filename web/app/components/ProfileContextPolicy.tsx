import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useState } from "react";
import { api } from "../api/client";
import type { ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { HelpTip, SentenceText } from "./HelpTip";

type Draft = { revision: number; options: Record<string, unknown>; minutes: string };

function draft(profile: ModelProfile): Draft {
    const options = profile.options as Record<string, unknown>;
    return { revision: profile.revision, options, minutes: String(options.auto_clear_minutes ?? "") };
}

export function ProfileContextPolicy({ profile }: { profile: ModelProfile }) {
    const supported = useCapability("context_auto_clear_v1");
    const [editing, setEditing] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (supported === false) return null;
    const minutes = (profile.options as Record<string, unknown>).auto_clear_minutes;
    const save = async () => {
        if (!editing) return;
        setBusy(true);
        setError(null);
        try {
            const options = { ...editing.options };
            if (editing.minutes === "") delete options.auto_clear_minutes;
            else options.auto_clear_minutes = Number(editing.minutes);
            await api.put(`/model-profiles/${profile.id}`, { expected_revision: editing.revision, options }, { requires: ["context_auto_clear_v1"] });
            setEditing(null);
        } catch (error) {
            setError(error instanceof Error ? error.message : "context 설정 저장 실패");
        } finally {
            setBusy(false);
        }
    };
    return <div role="group" aria-label={`${profile.name} context 정책`} data-testid="profile-context-policy">
        <GroveText type="supporting" color="secondary">idle context: {minutes == null ? "범위별 설정 상속" : minutes === 0 ? "시간 제한 없이 유지" : `${minutes}분 뒤 다음 요청에서 초기화`}</GroveText>
        {!editing && <GroveButton type="button" className="ghost small" onClick={() => { setEditing(draft(profile)); setError(null); }}>context 정책 설정</GroveButton>}
        {editing && <form className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>idle context 초기화(분) <HelpTip label="idle context 초기화 도움말">
                <SentenceText text="다음 사용자 요청부터 적용합니다. 빈 값은 범위별 설정 상속, 0은 초기화 없음입니다. 화면 이력·파일을 삭제하거나 요약하지 않습니다." />
            </HelpTip>
                <input type="number" min="0" max="525600" step="1" aria-label="프로필 idle context 초기화(분)" value={editing.minutes} onChange={(event) => setEditing({ ...editing, minutes: event.target.value })} />
            </label>
            <GroveStack direction="horizontal" align="center" className="inline">
                <ServerActionButton type="submit" disabled={busy}>{busy ? "저장 중…" : "context 정책 저장"}</ServerActionButton>
                <GroveButton type="button" className="ghost" disabled={busy} onClick={() => setEditing(null)}>취소</GroveButton>
                {editing.revision !== profile.revision && <GroveButton type="button" className="ghost" disabled={busy} onClick={() => { setEditing(draft(profile)); setError(null); }}>현재 서버 값 불러오기</GroveButton>}
            </GroveStack>
            {editing.revision !== profile.revision && <GroveText as="p" display="block" type="inherit" color="warning" role="status">프로필 변경 감지 · 입력 보존 · 저장 시 revision 충돌 확인</GroveText>}
        </form>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
    </div>;
}
