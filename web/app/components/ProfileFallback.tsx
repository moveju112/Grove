import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import type { ModelProfile } from "../api/generated";
import { BooleanSelect } from "./BooleanSelect";
import { HelpTip, SentenceText } from "./HelpTip";
import { useProfileDraft } from "./settings/useProfileDraft";
import { AutosaveStatus } from "./settings/AutosaveStatus";
import { providerIcon } from "./usage/ProviderMark";

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
    if (!http(profile)) return null;
    const current = fallbackOptions(profile);
    return <GroveStack gap={2} role="group" aria-label={`${profile.name} fallback`} data-testid="profile-fallback">
        <GroveText type="supporting" color="secondary">{current.enabled
            ? `fallback · ${current.candidates.length}개 HTTP 후보`
            : "fallback 꺼짐 · HTTP 후보를 확인하면 켤 수 있어요"}</GroveText>
        <FallbackEditor profile={profile} profiles={profiles} />
    </GroveStack>;
}

function FallbackEditor({ profile, profiles }: { profile: ModelProfile; profiles: ModelProfile[] }) {
    const state = useProfileDraft("fallback", profile, (profile) => {
        const current = fallbackOptions(profile);
        return { options: profile.options as Record<string, unknown>, profiles,
            ids: current.candidates.map((candidate) => candidate.profile_id),
            confirmed: current.enabled && current.destination_change_confirmed };
    }, (draft) => fallbackPayload({ ...profile, options: draft.options }, draft.profiles, draft.ids, draft.confirmed).options, [], false);
    const editing = state.value;
    const busy = state.phase === "saving" || state.phase === "uncertain";
    const change = (ids: string[]) => {
        state.change({ ...editing, ids, confirmed: false });
        if (!ids.length) state.commit();
    };
    return <GroveStack gap={2}>
            <GroveStack direction="horizontal" align="center" gap={1.5}>전환 조건 <HelpTip label="fallback 전환 조건 도움말">
                <SentenceText text="동일 모델 재시도 후 첫 응답 전 HTTP 429·provider 5xx일 때만 전환합니다. 취소·인증·입력 오류·timeout·연결 유실·부분 응답·도구 실행 뒤에는 전환하지 않으며 권한과 예산은 유지됩니다. 후보가 CLI로 바뀌었다면 HTTP 후보를 골라 전송 대상을 다시 확인하세요." />
            </HelpTip></GroveStack>
            {editing.ids.map((id, index) => {
                const target = editing.profiles.find((p) => p.id === id);
                return <GroveStack gap={2} key={index}>
                    <Select label={`fallback ${index + 1}`} value={id} disabled={busy}
                        onChange={(next) => change(editing.ids.map((value, i) => i === index ? next : value))}
                        options={[...(!target ? [{ value: id, label: "사용할 수 없는 프로필" }] : []),
                            ...editing.profiles.filter((p) => p.id !== profile.id && p.enabled && http(p))
                                .map((p) => ({ value: p.id, icon: providerIcon(p.protocol), label: `${p.name} · ${p.protocol} · ${p.model}` }))]} />
                    {target && <GroveText as="p" display="block" type="supporting" color="secondary">전송 대상: {target.protocol} · {target.base_url} · {target.model}<br />가격표: {JSON.stringify((target.options as Record<string, unknown>).pricing ?? "미설정(비용 알 수 없음)")}</GroveText>}
                    <GroveButton type="button" disabled={busy} onClick={() => change(editing.ids.filter((_, i) => i !== index))}>후보 {index + 1} 제거</GroveButton>
                </GroveStack>;
            })}
            <GroveButton type="button" disabled={busy || editing.ids.length >= 4 || !editing.profiles.some((p) => p.id !== profile.id && p.enabled && http(p) && !editing.ids.includes(p.id))} onClick={() => {
                const next = editing.profiles.find((p) => p.id !== profile.id && p.enabled && http(p) && !editing.ids.includes(p.id));
                if (next) change([...editing.ids, next.id]);
            }}>마지막에 후보 추가</GroveButton>
            {editing.ids.length > 0 && <BooleanSelect label="위 순서의 다른 전송 대상·모델·가격으로 대화가 전달되는 것을 확인했습니다"
                value={editing.confirmed} disabled={busy} onChange={(confirmed) => {
                    state.change({ ...editing, confirmed });
                    if (confirmed) state.commit();
                }} trueLabel="확인함" falseLabel="확인 안 함" />}
        <AutosaveStatus state={state} />
    </GroveStack>;
}
