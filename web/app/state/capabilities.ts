import { useSyncExternalStore } from "react";
import { hasCapability, onCapabilities } from "../api/client";

/// 서버 기능 지원 여부(NET-001). false면 그 기능의 화면을 숨긴다. null(아직 모름)이면 보여 주되
/// 요청에 `requires`를 붙여 서버가 다시 확인하게 한다.
export function useCapability(name: string): boolean | null {
    return useSyncExternalStore(onCapabilities, () => hasCapability(name), () => null);
}
