import { describe, expect, it } from "vitest";
import { approvalFixture } from "./fixtures.test-support";
import {
    acceptedDecisionResponse, approvalExpired, approvalFailure, approvalKey, currentApprovalContract, displayText,
    projectApproval, sameApproval, statusLabels,
} from "./projection";

describe("승인 projection과 현재 서버 계약", () => {
    it("서버의 도구 effect와 대화 허용 제외를 유지한다", () => {
        expect(currentApprovalContract("read")).toEqual({ effect: "read", choices: ["approve", "approve_session", "deny"] });
        expect(currentApprovalContract("write").effect).toBe("write");
        expect(currentApprovalContract("shell").effect).toBe("execute");
        expect(currentApprovalContract("agent")).toEqual({ effect: "delegate", choices: ["approve", "deny"] });
        expect(currentApprovalContract("mcp_call")).toEqual({ effect: "execute", choices: ["approve", "deny"] });
        expect(currentApprovalContract("future-tool")).toEqual({ effect: null, choices: [] });
        expect(currentApprovalContract("__proto__")).toEqual({ effect: null, choices: [] });
        expect(currentApprovalContract("ask_user").choices).toEqual([]);
    });

    it("인자·파일 내용·diff·임의 필드·중첩 MCP 비밀값을 DOM용 데이터에서 제외한다", () => {
        const p = projectApproval(approvalFixture({
            name: "mcp_call",
            args: { token: "argument-sentinel" },
            target: {
                server_id: "srv", namespace: "srv.remote", tool_name: "remote", server_revision: 2,
                destination: { endpoint: "https://host/path?token=destination-sentinel", args: ["args-sentinel"] },
                arguments: { token: "nested-sentinel" }, preview: "preview-sentinel", diff: "diff-sentinel",
                brief: "brief-sentinel", arbitrary: "extra-sentinel",
            },
        }));
        expect(p.fields).toEqual([
            { label: "MCP 서버", value: "srv" }, { label: "MCP namespace", value: "srv.remote" },
            { label: "MCP 도구", value: "remote" }, { label: "서버 revision", value: "2" },
            { label: "외부 목적지", value: "https://host/path?[쿼리 숨김]" },
        ]);
        expect(JSON.stringify(p)).not.toContain("sentinel");
        expect(p.notices.join(" ")).toContain("read-only 표시는 권한 근거가 아닙니다");
    });

    it("웹 조회는 실행 승인으로 URL의 query를 숨기고 본문 상한을 보여준다", () => {
        expect(currentApprovalContract("web_fetch")).toEqual({ effect: "execute", choices: ["approve", "approve_session", "deny"] });
        const p = projectApproval(approvalFixture({
            name: "web_fetch",
            target: { tool: "web_fetch", url: "https://example.com/page?token=query-sentinel", max_bytes: 2048 },
        }));
        expect(p.fields).toEqual([
            { label: "요청 URL", value: "https://example.com/page?[쿼리 숨김]" },
            { label: "본문 상한", value: "2048바이트" },
        ]);
        expect(JSON.stringify(p)).not.toContain("sentinel");
        expect(p.notices.join(" ")).toContain("익명 GET");
    });

    it("알려진 credential을 자르기 전에 가리고 제어문자와 긴 인자를 제한한다", () => {
        const value = displayText('TOKEN="example-value" --password value-two Authorization: Bearer value-three https://user:pass@host/path?token=value-four sk-examplevalue123 \u202e');
        for (const secret of ["example-value", "value-two", "value-three", "user:pass", "value-four", "sk-examplevalue123", "\u202e"]) {
            expect(value).not.toContain(secret);
        }
        expect(displayText("😀".repeat(400))).toBe("😀".repeat(320) + "… (400자 중 일부)");
        expect(displayText("x".repeat(1000) + " TOKEN=secret", 20)).not.toContain("secret");
    });

    it("패치 작업과 이동 경로는 남기고 표시 수를 제한한다", () => {
        const p = projectApproval(approvalFixture({
            name: "apply_patch",
            target: { files: [
                { op: "delete", path: "old.txt", diff: "not-shown" },
                { op: "update", path: "from.txt", move_to: "to.txt", diff: "not-shown" },
                ...Array.from({ length: 20 }, (_, i) => ({ op: "add", path: `${i}.txt` })),
            ] },
        }));
        expect(p.fields.slice(0, 3)).toEqual([
            { label: "파일 삭제", value: "old.txt" }, { label: "파일 수정", value: "from.txt" },
            { label: "이동 대상", value: "to.txt" },
        ]);
        expect(p.fields).toHaveLength(21);
        expect(p.notices.join(" ")).toContain("22개 파일 중 20개");
        expect(JSON.stringify(p)).not.toContain("not-shown");
    });

    it("명령·위치·백그라운드와 상위 폴더 생성 계획을 구분한다", () => {
        const p = projectApproval(approvalFixture({
            name: "shell", target: { command: "pwd", cwd: "src", hold_ms: 0, timeout_ms: 1000, creates_dirs: true },
        }));
        expect(p.fields).toContainEqual({ label: "실행 명령", value: "pwd" });
        expect(p.fields).toContainEqual({ label: "작업 위치", value: "src" });
        expect(p.fields).toContainEqual({ label: "실행 방식", value: "즉시 백그라운드 실행" });
        expect(p.notices).toContain("없는 상위 디렉터리도 생성합니다.");
    });

    it("승인 identity에 session·id·revision을 모두 포함한다", () => {
        const call = approvalFixture();
        for (const other of [{ ...call, id: "other" }, { ...call, session_id: "other" }, { ...call, revision: 2 }]) {
            expect(sameApproval(call, other)).toBe(false);
            expect(approvalKey(call)).not.toBe(approvalKey(other));
        }
        const request = { id: call.id, session_id: call.session_id, revision: 1, decision: "approve" as const };
        expect(acceptedDecisionResponse(request, { ...call, status: "approved", revision: 2 })).toBe(true);
        expect(acceptedDecisionResponse(request, { ...call, status: "approved" })).toBe(false);
        expect(acceptedDecisionResponse(request, { ...call, id: "other", status: "approved", revision: 2 })).toBe(false);
        expect(acceptedDecisionResponse(request, { ...call, status: "pending_approval", revision: 2 })).toBe(false);
        expect(acceptedDecisionResponse(request, { ...call, status: "future-state", revision: 2 })).toBe(false);
    });

    it("만료·경합·권한·응답 유실을 성공으로 바꾸지 않고 원문 오류도 표시하지 않는다", () => {
        expect(approvalFailure({ code: "expired" }).kind).toBe("expired");
        expect(approvalFailure({ code: "already_decided" }).kind).toBe("processed");
        expect(approvalFailure({ code: "revision_conflict" }).kind).toBe("processed");
        expect(approvalFailure({ status: 403 }).kind).toBe("permission");
        expect(approvalFailure({ code: "read_only" }).kind).toBe("permission");
        expect(approvalFailure({ status: 400 }).kind).toBe("failed");
        expect(approvalFailure(new Error("sensitive-raw-message")).kind).toBe("unknown");
        expect(JSON.stringify(approvalFailure(new Error("sensitive-raw-message")))).not.toContain("sensitive-raw-message");
        expect(approvalFailure({ status: 503 }).kind).toBe("unknown");
        expect(approvalExpired("2030-01-01T00:00:00Z", Date.parse("2030-01-01T00:00:00Z"))).toBe(true);
        expect(approvalExpired("invalid-date", 0)).toBe(true);
        expect(approvalExpired(null, 0)).toBe(false);
        expect(statusLabels.approved).toContain("실행 전");
        expect(statusLabels.unknown).toContain("결과 불명");
    });
});
