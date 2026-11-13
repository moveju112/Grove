import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../api/generated";
import { ApiError, api } from "../../api/client";
import { invalidate } from "../../state/store";
import { SessionRow, StatusIcon, toolbarKeys } from "./index";
import { markSessionRead, pinSession, projectStatus, STATUS, type SidebarSession } from "./state";

vi.mock("../../api/client", () => ({
    ApiError: class extends Error {
        constructor(public status: number, public code: string, message: string, public retryable = false, public details?: unknown) { super(message); }
    },
    api: { post: vi.fn(), patch: vi.fn() },
}));
vi.mock("../../state/store", () => ({ invalidate: vi.fn(), useQuery: vi.fn() }));

const session: Session = {
    id: "s", project_id: "p", title: "<대화>", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    revision: 1, archived_at: null, parent_session_id: null, fork_message_seq: null, fork_inherits_context: false,
    workflow_id: null, last_message_seq: 7, active_turn: null, pending_approvals: 0, unreviewed_unknown: 0,
    bot_id: null, preview: null, unread: true, worktree_id: null,
};
const item: SidebarSession = { session, status: "completed", pinned: false, recent_id: "r", recent_revision: 4 };

beforeEach(() => vi.resetAllMocks());

describe("실제 서버 상태 표시", () => {
    it.each(Object.entries(STATUS))("%s는 색 이외의 아이콘·텍스트로 구분한다", (status, value) => {
        const html = renderToStaticMarkup(createElement(StatusIcon, { status }));
        expect(html).toContain(value.label);
        expect(html).toContain(`aria-hidden="true">${value.icon}`);
    });
    it("알 수 없는 상태를 완료로 추정하지 않는다", () => {
        expect(renderToStaticMarkup(createElement(StatusIcon, { status: "future-state" }))).toContain("상태 확인 필요");
        expect(projectStatus({ "future-state": 1 })).toBe("unknown");
    });
    it("프로젝트는 페이지 밖의 상태 집계로 우선순위를 정한다", () => {
        expect(projectStatus({ completed: 100, running: 1 })).toBe("running");
        expect(projectStatus({ failed: 1, awaiting_approval: 1, running: 2 })).toBe("awaiting_approval");
        expect(projectStatus({ completed: 3, failed: 1 })).toBe("failed");
        expect(projectStatus({})).toBe("idle");
    });
    it("핀·읽지 않음·toolbar를 텍스트와 native 버튼으로 표시하고 제목은 escape한다", () => {
        const html = renderToStaticMarkup(createElement(SessionRow, { item: { ...item, pinned: true }, open: vi.fn(), narrow: false }));
        expect(html).toContain("&lt;대화&gt;");
        expect(html).toContain('aria-label="고정됨"');
        expect(html).toContain("읽지 않음");
        expect(html).toContain('role="toolbar"');
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain('aria-label="세션 오른쪽에 열기"');
    });
    it("모바일은 분할 열기 버튼을 표시하지 않는다", () => {
        const html = renderToStaticMarkup(createElement(SessionRow, { item, open: vi.fn(), narrow: true }));
        expect(html).not.toContain("세션 오른쪽에 열기");
        expect(html).not.toContain("세션 아래에 열기");
        expect(html).toContain("읽음 표시");
    });
    it("toolbar 방향키는 활성 버튼 사이를 이동하고 Home·End를 지원한다", () => {
        const buttons = [{ focus: vi.fn() }, { focus: vi.fn() }, { focus: vi.fn() }];
        const preventDefault = vi.fn();
        const event = { currentTarget: { querySelectorAll: () => buttons }, target: buttons[0], preventDefault, key: "ArrowLeft" };
        toolbarKeys(event as unknown as Parameters<typeof toolbarKeys>[0]);
        expect(buttons[2]!.focus).toHaveBeenCalledTimes(1);
        toolbarKeys({ ...event, key: "ArrowRight" } as unknown as Parameters<typeof toolbarKeys>[0]);
        expect(buttons[1]!.focus).toHaveBeenCalledTimes(1);
        toolbarKeys({ ...event, target: buttons[1], key: "Home" } as unknown as Parameters<typeof toolbarKeys>[0]);
        expect(buttons[0]!.focus).toHaveBeenCalledTimes(1);
        toolbarKeys({ ...event, key: "End" } as unknown as Parameters<typeof toolbarKeys>[0]);
        expect(buttons[2]!.focus).toHaveBeenCalledTimes(2);
    });
});

describe("공유 recent 저장 계약", () => {
    it("기존 핀 변경은 숨김·읽음·접근 위치를 덮어쓰지 않는다", async () => {
        await pinSession(item, true);
        expect(api.post).not.toHaveBeenCalled();
        expect(api.patch).toHaveBeenCalledExactlyOnceWith("/recent/r", { expected_revision: 4, pinned: true });
        expect(invalidate).toHaveBeenCalledWith("recent");
    });
    it("열지 않은 세션은 최근 항목을 만든 뒤 그 revision으로 고정한다", async () => {
        vi.mocked(api.post).mockResolvedValue({ id: "new", revision: 1 });
        await pinSession({ ...item, recent_id: null, recent_revision: null }, true);
        expect(api.post).toHaveBeenCalledExactlyOnceWith("/recent/touch", { kind: "session", project_id: "p", resource_id: "s" });
        expect(api.patch).toHaveBeenCalledExactlyOnceWith("/recent/new", { expected_revision: 1, pinned: true });
    });
    it("동시 변경은 최신 revision 위에 핀 의도만 한 번 재적용한다", async () => {
        vi.mocked(api.patch).mockRejectedValueOnce(new ApiError(409, "revision_conflict", "conflict", false,
            { current: { pinned: false, hidden: true, revision: 9 } })).mockResolvedValueOnce({});
        await pinSession(item, true);
        expect(api.patch).toHaveBeenNthCalledWith(2, "/recent/r", { expected_revision: 9, pinned: true });
    });
    it("다른 기기가 이미 원하는 값으로 바꿨으면 재적용하지 않는다", async () => {
        vi.mocked(api.patch).mockRejectedValueOnce(new ApiError(409, "revision_conflict", "conflict", false,
            { current: { pinned: true, hidden: true, revision: 9 } }));
        await pinSession(item, true);
        expect(api.patch).toHaveBeenCalledTimes(1);
    });
    it("통신 오류를 성공으로 숨기거나 새 키로 자동 재시도하지 않는다", async () => {
        vi.mocked(api.patch).mockRejectedValueOnce(new Error("response lost"));
        await expect(pinSession(item, true)).rejects.toThrow("response lost");
        expect(api.patch).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledWith("recent");
    });
    it("읽음은 클릭 때 실제로 본 seq까지만 저장한다", async () => {
        await markSessionRead(item);
        expect(api.post).toHaveBeenCalledExactlyOnceWith("/recent/touch", {
            kind: "session", project_id: "p", resource_id: "s", view_state: { last_seen_seq: 7 },
        });
        expect(invalidate).toHaveBeenCalledWith("recent");
    });
    it("읽음 저장 실패도 표시를 낙관적으로 지우지 않는다", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new Error("offline"));
        await expect(markSessionRead(item)).rejects.toThrow("offline");
        expect(invalidate).toHaveBeenCalledWith("recent");
    });
});
