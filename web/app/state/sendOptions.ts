import type { AvailableModel, ModelCapabilities } from "../api/generated";

/// effort(UI-020): auto면 provider 기본값(아무것도 보내지 않음).
export const EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = typeof EFFORTS[number];
export type SendOptions = { mode: "model" | "save"; profileId: string | null; model?: string | null; agentId: string | null; tools?: boolean; toolOverride?: boolean; effort?: Effort; serviceTier?: string | null; nativeCommand?: string };
export type FollowKind = "queue" | "steer" | "interrupt";

// Fast 꺼짐은 지원 프로필에만 default를 보낸다. 다른 공급자에 속도 override를 넘기지 않는다.
// 미지원 Fast 선택은 보존해 사용자가 직접 끄도록 한다.
export function serviceTierForProfile(value: SendOptions["serviceTier"], capabilities: ModelCapabilities | undefined): string | null {
    if (!value || value === "default") return capabilities?.fast ? "default" : null;
    return value;
}

// 지원이 확인되지 않은 모델의 Fast는 보내지 않고 꺼진 것으로 보인다. 저장된 선택은 그대로 두어 지원 모델로 돌아가면 다시 켜진다.
// 모델 목록을 받기 전에는 판단하지 않는다. 그동안은 capabilityProblem이 전송을 막는다.
export function supportedServiceTier(value: SendOptions["serviceTier"], capabilities: ModelCapabilities | undefined,
    model: AvailableModel | undefined, catalogLoaded: boolean): string | null {
    const tier = serviceTierForProfile(value, capabilities);
    if (!tier || tier === "default" || !capabilities) return tier;
    if (!capabilities.fast || catalogLoaded && !model?.service_tiers?.some((entry) => entry.id === tier)) return serviceTierForProfile(null, capabilities);
    return tier;
}

/// 저장된 선택값을 현재 목록에 맞춰 실제로 쓸 값으로 바꾼다.
/// 선택값을 effect로 상태에 복사하지 않고 렌더마다 계산해, 화면에 보이는 선택과 보내는 값이 항상 같게 한다.
/// - 프로필: 명시적 저장값은 없어져도 보존한다. 선택이 없을 때만 첫 프로필을 쓴다.
export function resolveOptions(o: SendOptions, profileIds: string[] | undefined): SendOptions {
    const profileId = profileIds === undefined ? null : o.profileId || profileIds[0] || null;
    return { ...o, profileId };
}

// 기존 탭의 명시적 선택은 호출 전에 복원한다. 새 입력창에만 범위별 기본값 → 기기 선택 → 첫 모델을 적용한다.
export function initialProfile(configured: unknown, deviceProfile: string | null, profileIds: readonly string[]): string | null {
    return typeof configured === "string" && configured ? configured : deviceProfile || profileIds[0] || null;
}

/// UI의 실행 상태가 아니라 사용자가 선택한 입력을 비교한다. auto와 생략은 같은 요청이다.
export function sendOptionsSignature(o: SendOptions, attachments: readonly string[]): string {
    const normalized = {
        mode: o.mode, profileId: o.profileId, agentId: o.agentId, tools: o.tools, effort: o.effort ?? "auto",
        ...(o.toolOverride !== undefined ? { toolOverride: o.toolOverride } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(o.serviceTier ? { serviceTier: o.serviceTier } : {}),
        ...(o.nativeCommand ? { nativeCommand: o.nativeCommand } : {}),
    } satisfies SendOptions;
    return JSON.stringify([normalized, attachments]);
}

export function modelOptionCapabilities(o: SendOptions): string[] {
    return [
        ...(o.model ? ["turn_model_selection_v1"] : []),
        ...(o.serviceTier || (o.effort && ["xhigh", "max", "ultra"].includes(o.effort)) ? ["turn_model_options_v1"] : []),
        ...(o.nativeCommand ? ["native_skills_v1"] : []),
    ];
}

export function capabilityProblem(c: ModelCapabilities | undefined, options: SendOptions, images: boolean, model?: AvailableModel): string | null {
    if (options.mode !== "model") return null;
    if (options.tools && c?.tools === false) return "선택한 모델은 Grove 도구 루프 미지원입니다. 도구를 끄거나 다른 모델을 선택하세요.";
    if (options.effort && options.effort !== "auto" && c?.effort === false) return "선택한 모델은 추론 미지원입니다. auto 또는 다른 모델을 선택하세요.";
    if (images && c?.images === false) return "선택한 모델은 이미지 입력 미지원입니다. 첨부를 제거하거나 다른 모델을 선택하세요.";
    if (options.effort && ["xhigh", "max", "ultra"].includes(options.effort) && !model?.reasoning_efforts?.includes(options.effort)) {
        return "선택한 모델이 지원하는 추론 옵션을 선택하세요.";
    }
    if (options.effort && options.effort !== "auto" && model?.reasoning_efforts && !model.reasoning_efforts.includes(options.effort)) {
        return "선택한 모델이 지원하는 추론 옵션을 선택하세요.";
    }
    if (options.serviceTier && (c?.fast === false || (options.serviceTier !== "default" && !model?.service_tiers?.some((t) => t.id === options.serviceTier)))) {
        return "선택한 모델이 지원하는 속도를 선택하세요.";
    }
    return null;
}
