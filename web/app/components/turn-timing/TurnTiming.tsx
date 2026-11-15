import { HintText } from "../../design/HintText";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "../../api/client";
import type { Turn } from "../../api/generated";
import { deliveryTiming } from "../../state/deliveryTiming";
import { usePaneVisible } from "../../state/paneVisibility";
import { useLive, useQuery } from "../../state/store";
import { elapsedMs, seconds, startTimingTimer, type TimingSample } from "./model";
import { useTimingEnabled } from "./preference";
import { DetailDialog } from "../ui/Controls";
import { Icon } from "../icons";

type Props = { sessionId: string; turn: Turn; messagesReady: boolean };
type Sample = TimingSample & { id: string; status: string; updated_at: string };
const ACTIVE = ["queued", "running", "awaiting_approval"];

// 끄거나 pane이 숨겨지면 조회 구독과 계산 timer 자체를 해제한다.
export function TurnTiming(props: Props) {
    const enabled = useTimingEnabled();
    const visible = usePaneVisible();
    return enabled && visible ? <EnabledTurnTiming key={props.turn.id} {...props} /> : null;
}

function EnabledTurnTiming({ sessionId, turn, messagesReady }: Props) {
    const connected = useLive((live) => live.status === "live");
    const q = useQuery<Sample>(`turns:${sessionId}:timing:${turn.id}`, async () => {
        const detail = await api.get<Omit<Sample, "receivedAt">>(`/turns/${turn.id}`);
        return { ...detail, receivedAt: performance.now() };
    });
    const [now, setNow] = useState(0);
    const [verifiedSince, setVerifiedSince] = useState(() => performance.now());
    const [deliveryMs, setDeliveryMs] = useState<number | null>(null);
    // 목록에서 종료를 이미 확인했으면 아직 도착하지 않은 상세 응답으로 시간을 늘리지 않는다.
    const sample = q.data?.id === turn.id && !(q.data.timing.running && !ACTIVE.includes(turn.status)) ? q.data : undefined;
    const advance = !!sample?.timing.running && sample.receivedAt >= verifiedSince && connected && !q.error;

    useLayoutEffect(() => {
        // 재연결 전에 cache에 남은 표본으로 끊긴 동안의 시간을 추정하지 않는다.
        if (connected) setVerifiedSince(performance.now());
    }, [connected]);
    useEffect(() => {
        // 재연결·pane 복귀 때 cache의 진행 중 기록을 그대로 계속 늘리지 않는다.
        if (connected && q.data) q.reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, turn.id]);
    useEffect(() => startTimingTimer(advance, () => {
        const at = performance.now();
        setNow(at);
        // 이벤트 유실에도 서버 상태로 다시 맞춘다. 이미 진행 중인 조회와 겹치지 않는다.
        if (sample && at - sample.receivedAt >= 15_000 && !q.loading) q.reload();
        // reload/loading은 한 조회 표본 안에서 최신 값이 필요하므로 아래 effect를 갱신한다.
    }), [advance, sample, q.loading]); // eslint-disable-line react-hooks/exhaustive-deps
    useLayoutEffect(() => {
        if (messagesReady && sample && !sample.timing.running) setDeliveryMs(deliveryTiming.applied(turn.id));
    }, [messagesReady, sample, turn.id]);

    const retry = q.error && connected ? <GroveButton variant="secondary" density="compact" onClick={q.reload}>시간 다시 확인</GroveButton> : null;
    if (!sample) return q.error ? <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="turn-timing">턴 시간을 확인하지 못했습니다{retry}</GroveText> : null;
    const total = elapsedMs(sample, now, advance);
    return <><TimingSummary sample={sample} total={total} connected={connected && !q.error} deliveryMs={deliveryMs} />{retry}</>;
}

export function TimingSummary({ sample, total, connected, deliveryMs = null }: {
    sample: Sample; total: number; connected: boolean; deliveryMs?: number | null;
}) {
    const status = STATUS[sample.status] ?? "";
    return <GroveText as="div" display="block" type="supporting" color="secondary" data-testid="turn-timing" data-elapsed-ms={Math.round(total)} data-running={sample.timing.running}>
        <DetailDialog label="요청 시간 상세" title="요청 시간" showExpand={false} trigger={<>
            <Icon name="clock" size={14} />
            {!sample.timing.running && "요청 "}{seconds(total)}{status}
            {sample.timing.running && !connected && " · 연결 끊김·마지막 확인 값"}
        </>}>
            <TimingBreakdown sample={sample} total={total} connected={connected} deliveryMs={deliveryMs} />
        </DetailDialog>
    </GroveText>;
}

const STATUS: Record<string, string> = {
    interrupted: " · 중단", cancelled: " · 취소", failed: " · 실패", awaiting_approval: " · 승인·답변 대기",
};

export function TimingBreakdown({ sample, total, connected, deliveryMs = null }: {
    sample: Sample; total: number; connected: boolean; deliveryMs?: number | null;
}) {
    const t = sample.timing;
    const status = STATUS[sample.status] ?? "";
    return (
        <HintText as="p" display="block"
            hint="서버가 기록한 시작·종료 시각 기준 총 경과입니다. 큐·승인·질문 대기를 포함하며 순수 실행 시간이 아닙니다.">
            {t.running ? "총 경과" : "마지막 요청 총 경과"} {seconds(total)}{status}
            {t.running ? " · 대기 포함" : <>
                {t.provider_ms != null ? ` · 공급자 ${seconds(t.provider_ms)} · 기타 ${seconds(t.other_ms ?? 0)}` : ` · 모델·처리 ${seconds(t.model_and_other_ms)}(공급자 미측정)`}
                {t.tool_ms > 0 && ` · 도구 ${seconds(t.tool_ms)}`}
                {t.approval_wait_ms > 0 && ` · 승인 대기 ${seconds(t.approval_wait_ms)}`}
            </>}
            {t.running && !connected && " · 연결 끊김·마지막 확인 값"}
            {deliveryMs != null && <HintText data-testid="ui-delivery" hint="SSE 수신 이후 조회·화면 반영 시간. 네트워크 편도 지연·이전 연결 끊김 시간은 포함하지 않습니다."> · 화면 반영(수신 후) {Math.round(deliveryMs)}ms</HintText>}
        </HintText>
    );
}
