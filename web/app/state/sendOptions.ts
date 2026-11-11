import type { ModelCapabilities } from "../api/generated";

/// effort(UI-020): auto면 provider 기본값(아무것도 보내지 않음).
export type Effort = "auto" | "low" | "medium" | "high";
export type SendOptions = { mode: "model" | "save"; profileId: string | null; agentId: string | null; tools: boolean; effort?: Effort };

/// 저장된 선택값을 현재 목록에 맞춰 실제로 쓸 값으로 바꾼다.
/// 선택값을 effect로 상태에 복사하지 않고 렌더마다 계산해, 화면에 보이는 선택과 보내는 값이 항상 같게 한다.
/// - 프로필: 저장값이 목록에 있으면 그것, 아니면 첫 프로필(목록이 없으면 null)
/// - 에이전트: 목록을 아직 못 불러왔으면 저장값 유지, 불러왔는데 없으면 null
export function resolveOptions(o: SendOptions, profileIds: string[] | undefined, agentIds: string[] | undefined): SendOptions {
    const profileId = profileIds === undefined ? null : o.profileId && profileIds.includes(o.profileId) ? o.profileId : (profileIds[0] ?? null);
    const agentId = o.agentId && agentIds !== undefined && !agentIds.includes(o.agentId) ? null : o.agentId;
    return { ...o, profileId, agentId };
}

/// UI의 실행 상태가 아니라 사용자가 선택한 입력을 비교한다. auto와 생략은 같은 요청이다.
export function sendOptionsSignature(o: SendOptions, attachments: readonly string[]): string {
    const normalized = {
        mode: o.mode, profileId: o.profileId, agentId: o.agentId, tools: o.tools, effort: o.effort ?? "auto",
    } satisfies Required<SendOptions>;
    return JSON.stringify([normalized, attachments]);
}

export function capabilityProblem(c: ModelCapabilities | undefined, options: SendOptions, images: boolean): string | null {
    if (options.mode !== "model") return null;
    if (options.tools && c?.tools === false) return "선택한 모델은 Grove 도구 루프 미지원입니다. 도구를 끄거나 다른 모델을 선택하세요.";
    if (options.effort && options.effort !== "auto" && c?.effort === false) return "선택한 모델은 추론 강도 미지원입니다. auto 또는 다른 모델을 선택하세요.";
    if (images && c?.images === false) return "선택한 모델은 이미지 입력 미지원입니다. 첨부를 제거하거나 다른 모델을 선택하세요.";
    return null;
}
