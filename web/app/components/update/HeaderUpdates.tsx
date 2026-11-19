import { useHoverCard } from "@astryxdesign/core/HoverCard";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, newKey } from "../../api/client";
import type { ServerUpdateStatus, UpdateCheck } from "../../api/updateSettings";
import { Button } from "../../design/Button";
import { invalidate, useQuery } from "../../state/store";
import { checkWebUpdate } from "../pwa";
import { ServerActionButton } from "../pwa/ServerActionButton";
import { updateResultUnknown, updateStatusKey } from "./updateState";

const label = "업데이트 확인";
const webResults = {
    available: "새 웹 버전이 준비됐어요.",
    up_to_date: "웹은 최신 버전이에요.",
    unavailable: "이 화면에서는 웹 업데이트를 확인할 수 없어요.",
    failed: "웹 업데이트 확인에 실패했어요.",
};

function daemonResult(check: UpdateCheck): string {
    if (check.status === "available" && check.release) {
        return check.release.artifact ? `새 데몬 버전: ${check.release.available}` : "새 버전에 이 플랫폼용 패키지가 없어요.";
    }
    if (check.status === "up_to_date") return "현재 채널에 더 새 데몬 버전이 없어요.";
    return check.error === "manifest_check_failed" ? "데몬 릴리스 정보를 검증하지 못했어요." : "데몬 업데이트 소스가 준비되지 않았어요.";
}

type CheckRequest = { revision: number; key: string };

export function HeaderUpdates({ connected, online }: { connected: boolean; online: boolean }) {
    const card = useHoverCard({ label, placement: "below", alignment: "end", touchTrigger: "tap" });
    const query = useQuery<ServerUpdateStatus>(connected && card.isOpen ? updateStatusKey : null, () => api.get("/updates/settings"));
    const [pending, setPending] = useState<CheckRequest | null>(null);
    const [checkingDaemon, setCheckingDaemon] = useState(false);
    const [check, setCheck] = useState<UpdateCheck | null>(null);
    const [daemonError, setDaemonError] = useState<string | null>(null);
    const sending = useRef(false);
    const [checkingWeb, setCheckingWeb] = useState(false);
    const [webResult, setWebResult] = useState<keyof typeof webResults | null>(null);
    const { hide } = card;
    useEffect(() => { if (!connected) hide(); }, [connected, hide]);

    async function runDaemon(request: CheckRequest) {
        if (sending.current) return;
        sending.current = true;
        setCheckingDaemon(true);
        setDaemonError(null);
        setCheck(null);
        try {
            const result = await api.post<{ last_check: UpdateCheck }>("/updates/check",
                { expected_revision: request.revision }, { key: request.key });
            setCheck(result.last_check);
            setPending(null);
            invalidate(updateStatusKey);
        } catch (error) {
            const definitelyNotSent = error instanceof ApiError && (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === false;
            if (!definitelyNotSent && updateResultUnknown(error)) {
                setPending(request);
                setDaemonError("결과 불명 · 같은 요청으로 다시 확인하세요.");
            } else {
                if (!definitelyNotSent) setPending(null);
                setDaemonError(error instanceof ApiError ? error.message : "데몬 업데이트 확인에 실패했어요.");
                if (error instanceof ApiError && error.code === "revision_conflict") invalidate(updateStatusKey);
            }
        } finally {
            sending.current = false;
            setCheckingDaemon(false);
        }
    }

    async function runWeb() {
        setCheckingWeb(true);
        setWebResult(null);
        const result = await checkWebUpdate();
        // 새 버전의 전역 안내 위에 연결 팝오버를 남겨 두지 않는다.
        if (result === "available") hide();
        setWebResult(result);
        setCheckingWeb(false);
    }

    if (!connected) return null;
    const data = query.data;
    const lastCheck = check ?? data?.last_check;
    return <>
        <span role="status" aria-description="서버 연결 상태: 연결됨" data-testid="conn">
            <Button ref={card.ref} type="button" appearance="icon" density="compact" width={28}
                aria-label="업데이트 확인" aria-haspopup="dialog" aria-expanded={card.isOpen} aria-controls={card.isOpen ? card.id : undefined}
                onClick={(event) => {
                    // 터치 열기·닫기는 HoverCard가 담당한다.
                    if (event.detail === 0 || (event.nativeEvent as PointerEvent).pointerType === "mouse") card.show();
                }}>
                <StatusDot variant="success" label="연결됨" />
                <VisuallyHidden>연결됨</VisuallyHidden>
            </Button>
        </span>
        {card.renderHoverCard(<Stack gap={3} width={224}>
            <Text type="supporting" color="secondary">서버 연결됨{data ? ` · 데몬 ${data.server.version}` : ""}</Text>
            <Stack gap={1}>
                <ServerActionButton type="button" variant="secondary" density="compact"
                    disabled={checkingDaemon || !data?.can_manage || Boolean(query.error) || query.loading}
                    onClick={() => data && void runDaemon(pending ?? { revision: data.settings.revision, key: newKey() })}>
                    {checkingDaemon ? "데몬 확인 중…" : pending ? "같은 데몬 확인 요청 확인" : "데몬 업데이트 확인"}
                </ServerActionButton>
                {data && !data.can_manage && <Text type="supporting" color="secondary">이 서버에서는 업데이트 확인을 할 수 없어요.</Text>}
                {!!query.error && <Button type="button" appearance="link" onClick={query.reload}>데몬 상태 다시 조회</Button>}
                {daemonError ? <Text type="supporting" color="error" role="alert">{daemonError}</Text>
                    : !checkingDaemon && lastCheck && lastCheck.settings_revision === data?.settings.revision &&
                    <Text type="supporting" role="status">{daemonResult(lastCheck)}</Text>}
            </Stack>
            <Stack gap={1}>
                <Button type="button" variant="secondary" density="compact" disabled={!online || checkingWeb} onClick={() => void runWeb()}>
                    {checkingWeb ? "웹 확인 중…" : "웹 업데이트 확인"}
                </Button>
                {webResult && <Text type="supporting" role="status">{webResults[webResult]}</Text>}
            </Stack>
        </Stack>)}
    </>;
}
