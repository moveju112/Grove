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
    return <div className="stack" data-testid="server-update-settings">
        {query.loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">서버 업데이트 설정 불러오는 중</GroveText>}
        {!!query.error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">서버 업데이트 설정 조회 실패</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">{error}</GroveText>}
        {message && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{message}</GroveText>}
        {unknown && attempt && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">결과 불명 · 새 요청 전에 같은 요청으로 확인하세요.
            <GroveButton onClick={() => void mutate(attempt)}>같은 업데이트 요청 확인</GroveButton>
        </GroveText>}
        <GroveButton className="ghost small" disabled={!!attempt || query.loading} onClick={query.reload}>서버 업데이트 상태 새로 조회</GroveButton>
        {query.data && <UpdateSettingsPanel key={query.data.settings.revision} data={query.data} blocked={!!attempt || !!query.error || query.loading}
            onSave={(body) => void mutate({ kind: "save", body, key: newKey() })}
            onCheck={() => void mutate({ kind: "check", body: { expected_revision: query.data!.settings.revision }, key: newKey() })} />}
    </div>;
}

export function UpdateSettingsPanel({ data, blocked, onSave, onCheck }: {
    data: ServerUpdateStatus; blocked: boolean;
    onSave: (body: SaveUpdatePreferences) => void; onCheck: () => void;
}) {
    const [channel, setChannel] = useState<UpdateChannel>(data.settings.channel);
    const [scope, setScope] = useState<AutoApplyScope>(data.settings.auto_apply);
    const dirty = channel !== data.settings.channel || scope !== data.settings.auto_apply;
    return <>
        <dl className="kv" data-testid="server-update-version">
            <dt>현재 서버 버전</dt><dd>{data.server.version}</dd>
            <dt>서버 protocol</dt><dd>{data.server.protocol}</dd>
            <dt>DB schema</dt><dd>{data.server.schema}</dd>
        </dl>
        {!data.can_manage && <GroveText as="p" display="block" type="inherit" color="inherit">읽기 전용 · 소유자만 서버 업데이트 설정을 변경하거나 확인할 수 있습니다.</GroveText>}
        <form onSubmit={(e) => { e.preventDefault(); onSave({ channel, auto_apply: scope, expected_revision: data.settings.revision }); }}>
            <fieldset disabled={!data.can_manage || blocked}>
                <legend>서버 업데이트 설정</legend>
                <label>업데이트 채널<select aria-label="업데이트 채널" value={channel} onChange={(e) => setChannel(e.target.value as UpdateChannel)}>
                    <option value="stable">stable · 안정</option><option value="beta">beta · 시험 버전</option>
                </select></label>
                <label>자동 적용 범위<select aria-label="자동 적용 범위" value={scope} onChange={(e) => setScope(e.target.value as AutoApplyScope)}>
                    <option value="notify_only">알림만 (기본값)</option>
                    <option value="patch">patch 버전까지</option>
                    <option value="minor">minor 버전까지</option>
                </select></label>
                <GroveText as="p" display="block" type="inherit" color="inherit" className="scope">설정만 저장 · 설치·재시작 없음</GroveText>
                <GroveButton type="submit" disabled={!dirty}>서버 업데이트 설정 저장</GroveButton>
                <GroveButton type="button" disabled={dirty} onClick={onCheck}>서버 업데이트 확인</GroveButton>
                {dirty && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">변경한 설정을 저장한 뒤 해당 채널을 확인하세요.</GroveText>}
            </fieldset>
        </form>
        <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{data.readiness.idle ? "현재 유휴 상태" : "적용 보류 · 진행 중 작업이 있습니다."}</GroveText>
        {!data.readiness.idle && <dl className="kv" aria-label="업데이트 보류 대상">
            {Object.entries(data.readiness.busy).filter(([, count]) => count > 0).map(([kind, count]) => <div key={kind}><dt>{busyLabels[kind] ?? kind}</dt><dd>{count}</dd></div>)}
        </dl>}
        {data.last_check && data.last_check.settings_revision !== data.settings.revision
            && <GroveText as="p" display="block" type="inherit" color="inherit">이전 설정의 결과이니 현재 저장된 채널로 다시 확인하세요.</GroveText>}
        <CheckResult check={data.last_check} />
    </>;
}

const busyLabels: Record<string, string> = {
    active_turns: "실행·대기 턴", awaiting_approval: "승인 대기", running_tasks: "실행 중 작업",
    running_terminals: "실행 중 터미널", schedules_within_10m: "10분 내 예약", running_schedule_runs: "실행 중 예약",
    running_mcp_checks: "MCP 확인", running_mcp_calls: "MCP 호출",
};
export function CheckResult({ check }: { check: UpdateCheck | null }) {
    if (!check) return <GroveText as="p" display="block" type="inherit" color="inherit">아직 서버 업데이트를 확인하지 않았습니다.</GroveText>;
    return <div role="status" data-testid="server-update-check-result">
        <GroveText as="p" display="block" type="inherit" color="inherit">마지막 확인 · {check.channel} · <When at={check.checked_at} /></GroveText>
        {check.status === "failed" ? <GroveText as="p" display="block" type="inherit" color="inherit">서버 업데이트 확인 실패 · {check.error === "manifest_check_failed"
            ? "manifest 서명·채널·내용을 확인하지 못했습니다." : "로컬 업데이트 소스가 준비되지 않았습니다."}</GroveText>
            : <GroveText as="p" display="block" type="inherit" color="inherit">{check.status === "available" ? `새 서버 버전 ${check.release?.available}`
                : check.release?.kind === "downgrade" ? "선택한 채널에 더 새로운 서버 버전이 없습니다." : "현재 서버는 선택한 채널의 최신 버전입니다."}</GroveText>}
        {check.release && <GroveText as="p" display="block" type="inherit" color="inherit">후보 protocol {check.release.protocol} · schema {check.release.schema}
            {!check.release.artifact && " · 현재 플랫폼의 패키지가 없습니다."}
            {check.release.kind === "downgrade" && " · 후보는 현재 서버보다 이전 버전입니다."}</GroveText>}
    </div>;
}
