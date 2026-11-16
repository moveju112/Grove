import { useRef, useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ApiError, newKey } from "../api/client";
import type { PushTest } from "../api/generated";
import { createPushTest, getPushTest, type PushTestRequest } from "../api/pushTests";
import { pushRegistration } from "../state/webPush";
import { pushBrowserMessage, readPushBrowserStatus } from "../state/pushDiagnostics";
import { requireServerAction } from "./pwa/lifecycle";
import { ServerActionButton } from "./pwa/ServerActionButton";

type Attempt = { body: PushTestRequest; key: string };
type Row = { receipt?: PushTest; message?: string; browserMessage?: string };
const CASES = [
    { delay: 0, label: "7. 실제 Push 지금 시험" },
    { delay: 10, label: "8. 실제 Push 10초 뒤 예약" },
] as const;

export function pushTestMessage(receipt: PushTest): string {
    if (receipt.state === "sent") return "Push 서비스가 전송을 수락했어. 실제 알림 도착·소리·진동은 폰에서 확인해줘.";
    if (receipt.state === "failed") return `Push 전송 실패 (${receipt.error ?? "원인 미확인"}).`;
    return receipt.error ? `재시도 대기 (${receipt.error}).` : "서버에 접수됐어. 전송 대기 중이야.";
}

export function PushNotificationTests() {
    const [rows, setRows] = useState<Partial<Record<0 | 10, Row>>>({});
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [busy, setBusy] = useState(false);
    const sending = useRef(false);
    const run = async (delay: 0 | 10, retry?: Attempt) => {
        if (sending.current) return;
        sending.current = true; setBusy(true);
        setRows((current) => ({ ...current, [delay]: {} }));
        let request = retry;
        try {
            requireServerAction();
            if (!request) {
                const registration = await pushRegistration();
                const subscription = await registration.pushManager.getSubscription();
                if (!subscription) throw new Error("먼저 '앱을 닫아도 완료 알림'을 켜줘.");
                request = { body: { endpoint: subscription.endpoint, delay_seconds: delay }, key: newKey() };
            }
            setAttempt(request);
            const receipt = await createPushTest(request.body, request.key);
            setRows((current) => ({ ...current, [delay]: { receipt } }));
            setAttempt(null);
        } catch (error) {
            const uncertain = !!request && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status === 408);
            setAttempt(uncertain ? request! : null);
            setRows((current) => ({ ...current, [delay]: {
                ...current[delay],
                message: uncertain ? "접수 결과 불명. 새 시험 대신 같은 요청으로 확인해줘."
                    : error instanceof Error ? error.message : "Push 시험을 접수하지 못했어.",
            } }));
        } finally { sending.current = false; setBusy(false); }
    };
    const refresh = async (delay: 0 | 10, receipt: PushTest) => {
        if (sending.current) return;
        sending.current = true; setBusy(true);
        try {
            const latest = await getPushTest(receipt.id);
            setRows((current) => ({ ...current, [delay]: { receipt: latest } }));
            try {
                const browser = await readPushBrowserStatus(receipt.id);
                setRows((current) => ({ ...current, [delay]: { receipt: latest, browserMessage: pushBrowserMessage(browser) } }));
            } catch (error) {
                setRows((current) => ({ ...current, [delay]: { receipt: latest,
                    browserMessage: error instanceof Error ? error.message : "브라우저 수신 기록을 조회하지 못했어." } }));
            }
        } catch {
            setRows((current) => ({ ...current, [delay]: { ...current[delay], message: "전송 상태 조회에 실패했어. 이전 결과는 보존했어." } }));
        } finally { sending.current = false; setBusy(false); }
    };
    return <Stack gap={3} data-testid="push-notification-tests">
        <Text as="p" type="supporting" color="secondary">7·8번은 서버에서 이 기기로 실제 Push를 보내. 8번은 10초 이후 전송하며, 앱을 닫아도 예약은 유지돼. 전송 상태는 따로 확인할 수 있어.</Text>
        {CASES.map(({ delay, label }) => <Stack key={delay} gap={1}>
            <ServerActionButton type="button" variant="secondary" density="compact" width="100%" disabled={busy || !!attempt}
                onClick={() => void run(delay)}>{label}</ServerActionButton>
            {rows[delay] && <Text as="p" type="supporting" role="status" data-testid={`push-test-result-${delay}`}
                color={rows[delay].message || rows[delay].receipt?.state === "failed" ? "warning" : "secondary"}>
                {rows[delay].message ?? (rows[delay].receipt && pushTestMessage(rows[delay].receipt))}
            </Text>}
            {rows[delay]?.browserMessage && <Text as="p" type="supporting" role="status" color="secondary"
                data-testid={`push-browser-result-${delay}`}>{rows[delay].browserMessage}</Text>}
            {rows[delay]?.receipt && <ServerActionButton type="button" variant="secondary" density="compact" disabled={busy}
                onClick={() => void refresh(delay, rows[delay]!.receipt!)}>{delay === 0 ? "7번 전송 상태 확인" : "8번 전송 상태 확인"}</ServerActionButton>}
        </Stack>)}
        {attempt && !busy && <ServerActionButton type="button" variant="secondary" density="compact"
            onClick={() => void run(attempt.body.delay_seconds, attempt)}>같은 Push 시험 요청 확인</ServerActionButton>}
    </Stack>;
}
