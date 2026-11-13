import type { GitContext, GitContextState } from "../../api/gitContext";

export const contextLabel: Record<GitContextState, string> = {
    ok: "확인됨", none: "결과 없음", unsupported: "미지원 remote (GitHub.com만 조회)",
    missing: "서버 GitHub CLI 없음", unauthenticated: "GitHub CLI 미인증", denied: "GitHub 접근 거부 또는 비공개 대상 접근 불가",
    timeout: "조회 시간 초과", unknown: "확인 불가", stale: "오래된 응답 — 다시 확인 필요",
    unborn: "첫 커밋 전", no_remote: "origin 없음", success: "성공", failure: "실패·취소·조치 필요",
    pending: "진행·대기 중", neutral: "중립·건너뜀",
};

export function contextMatches(data: GitContext, projectId: string, head?: string): boolean {
    return data.project_id === projectId && (!head || (head === "(initial)" ? data.location?.kind === "unborn" : data.location?.head === head));
}
