import { pushRegistration } from "./webPush";

const STAGES = ["received", "rejected", "registered", "display_failed"] as const;
export type PushBrowserStatus = {
    version: string;
    storageError: boolean;
    receipt: { stage: typeof STAGES[number]; error: string | null; version: string; at: number } | null;
};

export async function readPushBrowserStatus(testId: string): Promise<PushBrowserStatus> {
    const registration = await pushRegistration();
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const finish = () => { clearTimeout(timeout); channel.port1.close(); };
        const timeout = setTimeout(() => {
            finish();
            reject(new Error("수신 기록 조회에 응답이 없어. 이전 서비스 워커가 실행 중일 수 있어."));
        }, 5000);
        channel.port1.onmessage = (event: MessageEvent) => {
            finish();
            const data = event.data as Partial<PushBrowserStatus> & { type?: string; testId?: string };
            const receipt = data?.receipt;
            if (data?.type !== "push-test-status" || data.testId !== testId || typeof data.version !== "string"
                || typeof data.storageError !== "boolean" || (receipt !== null && (!receipt
                    || !STAGES.includes(receipt.stage) || typeof receipt.version !== "string" || typeof receipt.at !== "number"
                    || !(receipt.error === null || typeof receipt.error === "string")))) {
                reject(new Error("수신 기록 응답을 확인하지 못했어."));
                return;
            }
            resolve({ version: data.version, storageError: data.storageError, receipt: receipt! });
        };
        channel.port1.onmessageerror = () => {
            finish();
            reject(new Error("수신 기록 응답을 읽지 못했어."));
        };
        try {
            registration.active!.postMessage({ type: "push-test-status", testId }, [channel.port2]);
        } catch (error) {
            channel.port2.close(); finish(); reject(error);
        }
    });
}

export function pushBrowserMessage(status: PushBrowserStatus): string {
    const suffix = ` · 워커 ${status.version}`;
    if (status.storageError) return `기기 안의 수신 기록 저장·조회에 실패했어${suffix}`;
    const receipt = status.receipt;
    if (!receipt) return `수신 기록 없음. 새 시험 후 다시 확인해줘. 기록 없음만으로 미수신을 확정할 수는 없어${suffix}`;
    switch (receipt.stage) {
        case "received": return `이 브라우저까지 Push 수신됨. 알림 등록 결과는 아직 없어${suffix}`;
        case "rejected": return `Push 수신 후 내용 검증에서 거부됨 (${receipt.error})${suffix}`;
        case "display_failed": return `Push 수신 후 알림 등록 실패 (${receipt.error})${suffix}`;
        case "registered": return `이 브라우저의 Push 수신·알림 등록 확인됨. 실제 화면 표시는 별도야${suffix}`;
    }
}
