import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useState } from "react";
import { api } from "../api/client";
import type { ModelProfile } from "../api/generated";
import { BooleanSelect } from "./BooleanSelect";
import { HelpTip, SentenceText } from "./HelpTip";

type Candidate = { profile_id: string; revision: number };
type FallbackOptions = { enabled: boolean; destination_change_confirmed: boolean; candidates: Candidate[] };
const http = (profile: ModelProfile) => ["openai", "anthropic", "gemini"].includes(profile.protocol);

export function fallbackOptions(profile: ModelProfile): FallbackOptions {
    return (profile.options as { fallback?: FallbackOptions }).fallback
        ?? { enabled: false, destination_change_confirmed: false, candidates: [] };
}

export function fallbackPayload(profile: ModelProfile, profiles: ModelProfile[], ids: string[], confirmed: boolean) {
    if (ids.length > 4 || new Set(ids).size !== ids.length || ids.includes(profile.id)) throw new Error("후보는 중복 없이 1~4개까지 선택하세요.");
    if (ids.length && !confirmed) throw new Error("전송 대상 변경을 확인하세요.");
    const candidates = ids.map((id) => {
        const candidate = profiles.find((p) => p.id === id && p.enabled && http(p));
        if (!candidate) throw new Error("삭제·비활성·CLI 후보는 사용할 수 없습니다.");
        return { profile_id: id, revision: candidate.revision };
    });
    return {
        expected_revision: profile.revision,
        options: { ...(profile.options as Record<string, unknown>), fallback: {
            enabled: candidates.length > 0, destination_change_confirmed: confirmed, candidates,
        } },
    };
}

export function ProfileFallback({ profile, profiles }: { profile: ModelProfile; profiles: ModelProfile[] }) {
    const [editing, setEditing] = useState<{ profile: ModelProfile; profiles: ModelProfile[]; ids: string[] } | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    if (!http(profile)) return <GroveText as="p" display="block" type="supporting" color="secondary">CLI fallback 미지원</GroveText>;
    const current = fallbackOptions(profile);
    const save = async () => {
        if (!editing) return;
        setBusy(true);
        setError(null);
        try {
            await api.put(`/model-profiles/${profile.id}`, fallbackPayload(editing.profile, editing.profiles, editing.ids, confirmed));
            setEditing(null);
            setSaved(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : "fallback 저장 실패");
        } finally { setBusy(false); }
    };
    const change = (ids: string[]) => {
        if (!editing) return;
        setEditing({ ...editing, ids });
        setConfirmed(false);
    };
    return <GroveStack gap={0} role="group" aria-label={`${profile.name} fallback`} data-testid="profile-fallback">
        <GroveText type="supporting" color="secondary">fallback: {current.enabled ? `${current.candidates.length}개 명시적 HTTP 순서` : "꺼짐"}</GroveText>
        {!editing && <GroveButton type="button" variant="secondary" density="compact" onClick={() => {
            setEditing({ profile, profiles, ids: current.enabled ? current.candidates.map((c) => c.profile_id) : [] });
            setConfirmed(false); setError(null); setSaved(false);
        }}>fallback 설정</GroveButton>}
        {editing && <GroveStack as="form" gap={2} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <GroveStack direction="horizontal" align="center" gap={1.5}>전환 조건 <HelpTip label="fallback 전환 조건 도움말">
                <SentenceText text="동일 모델 재시도 후 첫 응답 전 HTTP 429·provider 5xx일 때만 전환합니다. 취소·인증·입력 오류·timeout·연결 유실·부분 응답·도구 실행 뒤에는 전환하지 않으며 권한과 예산은 유지됩니다." />
            </HelpTip></GroveStack>
            {editing.ids.map((id, index) => {
                const target = editing.profiles.find((p) => p.id === id);
                return <GroveStack gap={2} key={index}>
                    <Select label={`fallback ${index + 1}`} value={id} disabled={busy}
                        onChange={(next) => change(editing.ids.map((value, i) => i === index ? next : value))}
                        options={[...(!target ? [{ value: id, label: "사용할 수 없는 프로필" }] : []),
                            ...editing.profiles.filter((p) => p.id !== profile.id && p.enabled && http(p))
                                .map((p) => ({ value: p.id, label: `${p.name} · ${p.protocol} · ${p.model}` }))]} />
                    {target && <GroveText as="p" display="block" type="supporting" color="secondary">전송 대상: {target.protocol} · {target.base_url} · {target.model}<br />가격표: {JSON.stringify((target.options as Record<string, unknown>).pricing ?? "미설정(비용 알 수 없음)")}</GroveText>}
                    <GroveButton type="button" disabled={busy} onClick={() => change(editing.ids.filter((_, i) => i !== index))}>후보 {index + 1} 제거</GroveButton>
                </GroveStack>;
            })}
            <GroveButton type="button" disabled={busy || editing.ids.length >= 4 || !editing.profiles.some((p) => p.id !== profile.id && p.enabled && http(p) && !editing.ids.includes(p.id))} onClick={() => {
                const next = editing.profiles.find((p) => p.id !== profile.id && p.enabled && http(p) && !editing.ids.includes(p.id));
                if (next) change([...editing.ids, next.id]);
            }}>마지막에 후보 추가</GroveButton>
            {editing.ids.length > 0 && <BooleanSelect label="위 순서의 다른 전송 대상·모델·가격으로 대화가 전달되는 것을 확인했습니다"
                value={confirmed} disabled={busy} onChange={setConfirmed} trueLabel="확인함" falseLabel="확인 안 함" />}
            {editing.profile.revision !== profile.revision && <GroveText as="p" display="block" type="inherit" color="warning" role="status">프로필 변경 감지 · 입력 보존 · 저장 시 충돌하니 취소 후 현재 대상을 다시 확인하세요.</GroveText>}
            <GroveStack direction="horizontal" align="center" gap={1.5}>
                <GroveButton type="submit" disabled={busy || (editing.ids.length > 0 && !confirmed)}>fallback 저장</GroveButton>
                <GroveButton type="button" disabled={busy} onClick={() => setEditing(null)}>취소</GroveButton>
            </GroveStack>
        </GroveStack>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {saved && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">fallback 저장됨</GroveText>}
    </GroveStack>;
}
