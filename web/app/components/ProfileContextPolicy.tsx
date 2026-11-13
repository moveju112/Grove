import { useState } from "react";
import { api } from "../api/client";
import type { ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { ServerActionButton } from "./pwa/ServerActionButton";

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
        <span className="muted small">idle context: {minutes == null ? "범위별 설정 상속" : minutes === 0 ? "시간 제한 없이 유지" : `${minutes}분 뒤 다음 요청에서 초기화`}</span>
        {!editing && <button type="button" className="ghost small" onClick={() => { setEditing(draft(profile)); setError(null); }}>context 정책 설정</button>}
        {editing && <form className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <p className="muted small">이 공급자 프로필로 시작하는 다음 사용자 요청에 적용합니다. 빈 값은 범위별 설정 상속, 0은 자동 초기화 없음입니다. 화면 이력·파일은 삭제하지 않으며 요약도 만들지 않습니다.</p>
            <label>idle context 초기화(분)
                <input type="number" min="0" max="525600" step="1" aria-label="프로필 idle context 초기화(분)" value={editing.minutes} onChange={(event) => setEditing({ ...editing, minutes: event.target.value })} />
            </label>
            <div className="inline">
                <ServerActionButton type="submit" disabled={busy}>{busy ? "저장 중…" : "context 정책 저장"}</ServerActionButton>
                <button type="button" className="ghost" disabled={busy} onClick={() => setEditing(null)}>취소</button>
                {editing.revision !== profile.revision && <button type="button" className="ghost" disabled={busy} onClick={() => { setEditing(draft(profile)); setError(null); }}>현재 서버 값 불러오기</button>}
            </div>
            {editing.revision !== profile.revision && <p className="warn" role="status">편집 중 프로필이 변경됐습니다. 입력을 보존했으며 저장 시 충돌을 확인합니다.</p>}
        </form>}
        {error && <p className="err" role="alert">{error}</p>}
    </div>;
}
