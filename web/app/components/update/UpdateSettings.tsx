import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Select } from "../../design/Select";
import { KeyValues } from "../../design/KeyValues";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../../api/client";
import type { AutoApplyScope, SaveUpdatePreferences, ServerUpdateStatus, UpdateChannel, UpdateCheck } from "../../api/updateSettings";
import { setData, useQuery } from "../../state/store";
import { When } from "../When";

const queryKey = "server-update-settings";
type Attempt = { kind: "save"; body: SaveUpdatePreferences; key: string }
    | { kind: "check"; body: { expected_revision: number }; key: string };

export function updateResultUnknown(error: unknown): boolean {
    return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status === 408
        || error.code === "result_unknown"
        || (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
}

export function UpdateSettings() {
    const query = useQuery<ServerUpdateStatus>(queryKey, () => api.get("/updates/settings"));
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [unknown, setUnknown] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const sending = useRef(false);
    const mutate = async (request: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        setAttempt(request); setUnknown(false); setMessage(null); setError(null);
        let received = false;
        try {
            let savedRevision: number | null = null;
            if (request.kind === "save") {
                const saved = await api.put<{ settings: ServerUpdateStatus["settings"] }>("/updates/settings", request.body, { key: request.key });
                savedRevision = saved.settings.revision;
            } else {
                await api.post("/updates/check", request.body, { key: request.key });
            }
            received = true;
            // 저장 성공 응답과 실제 서버 재조회 완료를 구분한다.
            const confirmed = await api.get<ServerUpdateStatus>("/updates/settings");
            setData(queryKey, confirmed);
            setAttempt(null);
            const changed = savedRevision !== null && confirmed.settings.revision !== savedRevision;
            setMessage(request.kind === "save"
                ? changed ? "서버 저장 후 다른 요청으로 설정이 변경됐습니다. 현재 값을 다시 조회했습니다." : "서버에 저장됨 · 다시 조회해 확인했습니다."
                : "서버 업데이트 확인 결과를 다시 조회했습니다.");
        } catch (e) {
            const uncertain = received || updateResultUnknown(e);
            setUnknown(uncertain);
            if (!uncertain) setAttempt(null);
            setError(e instanceof ApiError ? e.message : "요청 결과를 확인할 수 없습니다.");
        } finally {
            sending.current = false;
        }
    };
    return <GroveStack gap={2} data-testid="server-update-settings">
        {query.loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">서버 업데이트 설정 불러오는 중</GroveText>}
        {!!query.error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">서버 업데이트 설정 조회 실패</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">{error}</GroveText>}
        {message && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{message}</GroveText>}
        {unknown && attempt && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">결과 불명 · 새 요청 전에 같은 요청으로 확인하세요.
            <GroveButton onClick={() => void mutate(attempt)}>같은 업데이트 요청 확인</GroveButton>
        </GroveText>}
        <GroveButton variant="secondary" density="compact" disabled={!!attempt || query.loading} onClick={query.reload}>서버 업데이트 상태 새로 조회</GroveButton>
        {query.data && <UpdateSettingsPanel key={query.data.settings.revision} data={query.data} blocked={!!attempt || !!query.error || query.loading}
            onSave={(body) => void mutate({ kind: "save", body, key: newKey() })}
            onCheck={() => void mutate({ kind: "check", body: { expected_revision: query.data!.settings.revision }, key: newKey() })} />}
    </GroveStack>;
}

export function UpdateSettingsPanel({ data, blocked, onSave, onCheck }: {
    data: ServerUpdateStatus; blocked: boolean;
    onSave: (body: SaveUpdatePreferences) => void; onCheck: () => void;
}) {
    const [channel, setChannel] = useState<UpdateChannel>(data.settings.channel);
    const [scope, setScope] = useState<AutoApplyScope>(data.settings.auto_apply);
    const dirty = channel !== data.settings.channel || scope !== data.settings.auto_apply;
    return <>
        <KeyValues data-testid="server-update-version" items={[
            ["현재 서버 버전", data.server.version], ["서버 protocol", data.server.protocol], ["DB schema", data.server.schema],
        ]} />
        {!data.can_manage && <GroveText as="p" display="block" type="inherit" color="inherit">읽기 전용 · 소유자만 서버 업데이트 설정을 변경하거나 확인할 수 있습니다.</GroveText>}
            <fieldset disabled={!data.can_manage || blocked}>
                <legend>서버 업데이트 설정</legend>
                <Select label="업데이트 채널" value={channel} disabled={!data.can_manage || blocked}
                    onChange={(value) => {
                        if (value === channel) return;
                        setChannel(value as UpdateChannel);
                        onSave({ channel: value as UpdateChannel, auto_apply: scope, expected_revision: data.settings.revision });
                    }}
                    options={[{ value: "stable", label: "stable · 안정" }, { value: "beta", label: "beta · 시험 버전" }]} />
                <Select label="자동 적용 범위" value={scope} disabled={!data.can_manage || blocked}
                    onChange={(value) => {
                        if (value === scope) return;
                        setScope(value as AutoApplyScope);
                        onSave({ channel, auto_apply: value as AutoApplyScope, expected_revision: data.settings.revision });
                    }}
                    options={[{ value: "notify_only", label: "알림만 (기본값)" },
                        { value: "patch", label: "patch 버전까지" }, { value: "minor", label: "minor 버전까지" }]} />
                <GroveText as="p" display="block" type="supporting" color="secondary">설정만 저장 · 설치·재시작 없음</GroveText>
                <GroveButton type="button" disabled={dirty} onClick={onCheck}>서버 업데이트 확인</GroveButton>
            </fieldset>
        <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{data.readiness.idle ? "현재 유휴 상태" : "적용 보류 · 진행 중 작업이 있습니다."}</GroveText>
        {!data.readiness.idle && <KeyValues aria-label="업데이트 보류 대상"
            items={Object.entries(data.readiness.busy).filter(([, count]) => count > 0).map(([kind, count]) => [busyLabels[kind] ?? kind, count])} />}
        {data.last_check && data.last_check.settings_revision !== data.settings.revision
            && <GroveText as="p" display="block" type="inherit" color="inherit">이전 설정의 결과이니 현재 저장된 채널로 다시 확인하세요.</GroveText>}
        <CheckResult check={data.last_check} />
    </>;
}

const busyLabels: Record<string, string> = {
    active_turns: "실행·대기 턴", awaiting_approval: "승인 대기", running_tasks: "실행 중 작업",
    running_terminals: "실행 중 터미널", schedules_within_10m: "10분 내 예약", running_schedule_runs: "실행 중 예약",
};
export function CheckResult({ check }: { check: UpdateCheck | null }) {
    if (!check) return <GroveText as="p" display="block" type="inherit" color="inherit">아직 서버 업데이트를 확인하지 않았습니다.</GroveText>;
    return <GroveStack gap={0} role="status" data-testid="server-update-check-result">
        <GroveText as="p" display="block" type="inherit" color="inherit">마지막 확인 · {check.channel} · <When at={check.checked_at} /></GroveText>
        {check.status === "failed" ? <GroveText as="p" display="block" type="inherit" color="inherit">서버 업데이트 확인 실패 · {check.error === "manifest_check_failed"
            ? "manifest 서명·채널·내용을 확인하지 못했습니다." : "로컬 업데이트 소스가 준비되지 않았습니다."}</GroveText>
            : <GroveText as="p" display="block" type="inherit" color="inherit">{check.status === "available" ? `새 서버 버전 ${check.release?.available}`
                : check.release?.kind === "downgrade" ? "선택한 채널에 더 새로운 서버 버전이 없습니다." : "현재 서버는 선택한 채널의 최신 버전입니다."}</GroveText>}
        {check.release && <GroveText as="p" display="block" type="inherit" color="inherit">후보 protocol {check.release.protocol} · schema {check.release.schema}
            {!check.release.artifact && " · 현재 플랫폼의 패키지가 없습니다."}
            {check.release.kind === "downgrade" && " · 후보는 현재 서버보다 이전 버전입니다."}</GroveText>}
    </GroveStack>;
}
