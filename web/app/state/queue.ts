// 모델 실행 대기 이유 표시(FAIR-011). 대화 화면과 사용량 화면이 같은 문구를 쓴다.
export type QueueInfo = { ahead: number; active: number; limit: number; reason?: "account" | "provider" | string | null };

const REASON: Record<string, string> = { account: "계정 한도", provider: "공급자 한도" };

export function queueText(q: QueueInfo): string {
    const reason = (q.reason && REASON[q.reason]) || "동시 실행";
    return `실행 차례를 기다리는 중 · ${reason} ${q.active}/${q.limit}${q.ahead > 0 ? ` · 앞에 ${q.ahead}개` : ""}`;
}
