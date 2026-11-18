import type { ToolCallRow } from "../../api/generated";

export type ApprovalEffect = "read" | "write" | "execute" | "delegate" | "conversation";
export type ApprovalDecision = "approve" | "approve_session" | "deny";
export type ApprovalIdentity = Pick<ToolCallRow, "id" | "session_id" | "revision">;
export type ApprovalRequest = ApprovalIdentity & { decision: ApprovalDecision };
export type ApprovalFailure = { kind: "expired" | "processed" | "permission" | "unknown" | "failed"; message: string };

// src/tools/mod.rs::specs 및 src/approvals.rs::decide의 현재 계약.
// 서버가 effect/선택지를 직접 제공하게 되면 호출부에서 그 값을 주입한다.
const effects: Readonly<Record<string, ApprovalEffect>> = {
    read: "read", list: "read", glob: "read", find: "read", grep: "read",
    write: "write", edit: "write", apply_patch: "write",
    shell: "execute", web_fetch: "execute", computer: "execute", agent: "delegate",
    goal: "conversation", recall: "conversation", ask_user: "conversation",
};

export function currentApprovalContract(name: string): { effect: ApprovalEffect | null; choices: readonly ApprovalDecision[] } {
    const effect = Object.hasOwn(effects, name) ? effects[name]! : null;
    return {
        effect,
        choices: !effect || name === "ask_user" ? [] : name === "agent"
            ? ["approve", "deny"] : ["approve", "approve_session", "deny"],
    };
}

export function sameApproval(a: ApprovalIdentity, b: ApprovalIdentity): boolean {
    return a.id === b.id && a.session_id === b.session_id && a.revision === b.revision;
}

export function approvalKey(call: ApprovalIdentity): string {
    return JSON.stringify([call.session_id, call.id, call.revision]);
}

export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// 알려진 자격증명 형식만 가린다. 자유 본문·MCP 인자·파일 diff는 아예 projection하지 않는다.
export function displayText(value: string, limit = 320): string {
    const safe = value
        .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[쿼리 숨김]")
        .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[인증정보 숨김]@")
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, "[인증정보 숨김]")
        .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[비밀값 숨김]")
        .replace(/((?:["']?[\w.-]*(?:token|password|passwd|secret|api[_-]?key|authorization|credential)[\w.-]*["']?)\s*(?:[:=]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, "$1[비밀값 숨김]")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
    const chars = Array.from(safe);
    return chars.length > limit ? chars.slice(0, limit).join("") + `… (${chars.length}자 중 일부)` : safe;
}

export type ApprovalProjection = { fields: { label: string; value: string }[]; notices: string[] };

export function projectApproval(call: Pick<ToolCallRow, "name" | "target">): ApprovalProjection {
    const target = record(call.target);
    const fields: ApprovalProjection["fields"] = [];
    const notices: string[] = [];
    const text = (key: string, label: string, limit = 320) => {
        if (typeof target[key] === "string") fields.push({ label, value: displayText(target[key], limit) });
    };
    const number = (key: string, label: string, suffix: string) => {
        if (typeof target[key] === "number" && Number.isFinite(target[key])) fields.push({ label, value: `${target[key]}${suffix}` });
    };
    text("path", "대상 경로");
    text("cwd", "작업 위치");
    text("command", "실행 명령", 1000);
    number("bytes", "쓰기 크기", "바이트");
    number("timeout_ms", "강제 종료 제한", "ms");
    if (typeof target.hold_ms === "number") {
        fields.push({ label: "실행 방식", value: target.hold_ms === 0 ? "즉시 백그라운드 실행" : `${target.hold_ms}ms 뒤 백그라운드 전환` });
    }
    if (target.creates_dirs === true) notices.push("없는 상위 디렉터리도 생성합니다.");
    if (call.name === "apply_patch" && Array.isArray(target.files)) {
        for (const item of target.files.slice(0, 20)) {
            const file = record(item);
            const op = file.op === "add" ? "추가" : file.op === "delete" ? "삭제" : file.op === "update" ? "수정" : "알 수 없는 변경";
            fields.push({ label: `파일 ${op}`, value: typeof file.path === "string" ? displayText(file.path) : "경로 정보 없음" });
            if (typeof file.move_to === "string") fields.push({ label: "이동 대상", value: displayText(file.move_to) });
        }
        if (target.files.length > 20) notices.push(`총 ${target.files.length}개 파일 중 20개만 표시합니다.`);
    }
    if (call.name === "agent") {
        text("action", "위임 동작");
        text("agent_id", "에이전트");
        text("run_id", "자식 작업");
        notices.push("모델 사용 비용이 발생합니다. 자식의 파일 변경·명령은 별도 승인을 받습니다.");
    }
    if (call.name === "mcp_call") {
        text("server_id", "MCP 서버");
        text("server_name", "서버 이름");
        text("namespace", "MCP namespace");
        text("tool_name", "MCP 도구");
        number("server_revision", "서버 revision", "");
        number("timeout_secs", "외부 호출 제한", "초");
        const destination = record(target.destination);
        if (typeof destination.endpoint === "string") fields.push({ label: "외부 목적지", value: displayText(destination.endpoint) });
        if (typeof destination.command === "string") fields.push({ label: "서버 실행 명령", value: displayText(destination.command) });
        notices.push("원격 read-only 표시는 권한 근거가 아닙니다. 외부 부작용이 발생할 수 있습니다.");
    }
    if (call.name === "computer") {
        fields.push({ label: "제어할 PC", value: "Grove 서버 PC (이 기기가 아님)" });
        text("action", "동작");
        text("window_id", "대상 창");
        text("frame_id", "관찰 화면");
        if (Array.isArray(target.actions)) {
            for (const entry of target.actions.slice(0, 6)) {
                const step = record(entry);
                const kind = typeof step.type === "string" ? displayText(step.type) : "알 수 없는 동작";
                const detail = step.type === "type" ? `입력 ${typeof step.text === "string" ? Array.from(step.text).length : 0}자`
                    : step.type === "key" ? displayText(String(step.key ?? ""))
                    : `${step.x}, ${step.y}${step.type === "scroll" ? ` · ${step.direction} ${step.amount}` : ` · ${step.button ?? "left"}`}`;
                fields.push({ label: kind, value: detail });
            }
        }
    }
    if (call.name === "web_fetch") {
        text("url", "요청 URL", 1000);
        number("max_bytes", "본문 상한", "바이트");
        notices.push("공개 인터넷 주소로 익명 GET 요청을 보냅니다. 받은 본문은 신뢰할 수 없는 데이터로 다룹니다.");
    }
    if (!fields.length) notices.push("서버가 표시 가능한 대상 정보를 제공하지 않았습니다.");
    return { fields, notices };
}

export const effectLabels: Record<ApprovalEffect, { label: string; consequence: string }> = {
    read: { label: "읽기", consequence: "프로젝트 내부 읽기 전용 작업입니다." },
    write: { label: "쓰기", consequence: "프로젝트 파일을 생성·수정·삭제·이동할 수 있습니다. 실제 변경 대상은 위 계획을 확인하세요." },
    execute: { label: "실행", consequence: "프로세스 실행 또는 외부 호출로 파일·시스템·외부 서비스에 부작용이 발생할 수 있습니다." },
    delegate: { label: "위임", consequence: "자식 에이전트 작업을 시작하거나 후속 지시를 보내며 모델 사용 비용이 발생합니다." },
    conversation: { label: "대화 데이터", consequence: "대화 데이터를 조회하거나 대화 상태를 변경합니다. 파일·프로세스 부작용은 없습니다." },
};

export const statusLabels: Readonly<Record<string, string>> = {
    pending_approval: "승인 대기", approved: "승인됨 · 실행 전", running: "실행 중 · 결과 미확정",
    succeeded: "실행 완료", denied: "거부됨 · 실행하지 않음", expired: "승인 만료 · 실행하지 않음",
    cancelled: "취소됨 · 이미 발생한 부작용은 별도 확인이 필요합니다", failed: "실패 · 승인 또는 실행 결과를 확인하세요",
    unknown: "결과 불명 · 자동으로 다시 승인하거나 실행하지 않습니다",
};

export function approvalFailure(error: unknown): ApprovalFailure {
    const e = record(error);
    const code = typeof e.code === "string" ? e.code : "";
    if (code === "expired") return { kind: "expired", message: "승인 시간이 지났습니다. 최신 요청을 확인하세요." };
    if (code === "already_decided" || code === "revision_conflict") return { kind: "processed", message: "이미 처리되었거나 변경된 요청입니다. 최신 상태를 확인하세요." };
    if (e.status === 401 || e.status === 403 || ["policy_denied", "read_only", "forbidden", "unauthorized"].includes(code)) {
        return { kind: "permission", message: "권한 또는 도구 정책으로 처리할 수 없습니다. 최신 상태와 권한을 확인하세요." };
    }
    if (typeof e.status === "number" && e.status >= 400 && e.status < 500) {
        return { kind: "failed", message: "승인 요청을 처리하지 못했습니다. 최신 상태를 확인하세요." };
    }
    return { kind: "unknown", message: "응답을 확인하지 못해 결과가 불명입니다. 다시 승인하지 말고 최신 상태를 확인하세요." };
}

export function acceptedDecisionResponse(request: ApprovalRequest, call: ToolCallRow): boolean {
    return call.id === request.id && call.session_id === request.session_id
        && call.revision > request.revision && Object.hasOwn(statusLabels, call.status) && call.status !== "pending_approval";
}

export function approvalExpired(expiresAt: string | null, now: number): boolean {
    return expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now);
}
