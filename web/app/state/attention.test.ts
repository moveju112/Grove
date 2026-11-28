import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../api/generated";
import { attentionFor, claimAttention, closeReadNotifications, notifyAttention, showAttention } from "./attention";
import { defaultPrefs } from "./device";
import { dismissDoneNotice, dismissSessionNotice, showSessionNotice } from "./sessionNotices";

vi.mock("./sessionNotices", () => ({ showSessionNotice: vi.fn(), dismissSessionNotice: vi.fn(), dismissDoneNotice: vi.fn() }));

const event = (kind: string, payload: unknown): EventRecord => ({ seq: 1, created_at: "2026-01-01T00:00:00Z", kind, project_id: "p", session_id: "s", payload });
const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("이 기기 알림 판단", () => {
    it("완료 알림은 최종 답변을 표시하고 미리보기가 없는 이벤트는 기본 문구를 쓴다", () => {
        expect(attentionFor(event("turn.updated", { id: "t", status: "completed", completion_preview: "최종 답변" }), defaultPrefs)).toMatchObject({ kind: "done", tag: "turn:t", projectId: "p", sessionId: "s", body: "최종 답변" });
        expect(attentionFor(event("turn.updated", { id: "t", status: "completed" }), defaultPrefs)?.body).toBe("대화의 요청 처리가 끝났습니다.");
        expect(attentionFor(event("turn.updated", { id: "t", status: "interrupted" }), defaultPrefs)?.kind).toBe("failed");
        expect(attentionFor(event("turn.updated", { id: "t", status: "awaiting_approval" }), defaultPrefs)?.tag).toBe("approval:t");
        expect(attentionFor(event("notification.created", { id: "n", title: "예약 완료" }), defaultPrefs)).toMatchObject({ kind: "server", title: "예약 완료" });
        expect(JSON.stringify(attentionFor(event("turn.updated", { id: "t", status: "completed", error: "secret" }), defaultPrefs))).not.toContain("secret");
    });
    it("답을 기다리는 질문은 질문 문구로 알리고 답한 질문·다른 도구는 알리지 않는다", () => {
        const call = { id: "c", turn_id: "t", name: "ask_user", status: "awaiting_input", target: { question: "  어느 쪽으로 갈까요?  " } };
        expect(attentionFor(event("tool_call.updated", call), defaultPrefs)).toMatchObject({ kind: "question", tag: "question:c", title: "질문", body: "어느 쪽으로 갈까요?" });
        expect(attentionFor(event("tool_call.updated", { ...call, target: {} }), defaultPrefs)?.body).toBe("대화에서 답을 기다립니다.");
        expect(attentionFor(event("tool_call.updated", { ...call, status: "succeeded" }), defaultPrefs)).toBeNull();
        expect(attentionFor(event("tool_call.updated", { ...call, name: "shell" }), defaultPrefs)).toBeNull();
        expect(attentionFor(event("tool_call.updated", call), { ...defaultPrefs, notifyApproval: false })).toBeNull();
    });
    it("꺼진 종류·진행 중·사용자 취소는 알리지 않는다", () => {
        expect(attentionFor(event("turn.updated", { id: "t", status: "completed" }), { ...defaultPrefs, notifyDone: false })).toBeNull();
        expect(attentionFor(event("turn.updated", { id: "t", status: "awaiting_approval" }), { ...defaultPrefs, notifyApproval: false })).toBeNull();
        expect(attentionFor(event("notification.created", { id: "n" }), { ...defaultPrefs, notifyServer: false })).toBeNull();
        expect(attentionFor(event("turn.updated", { id: "t", status: "running" }), defaultPrefs)).toBeNull();
        expect(attentionFor(event("turn.updated", { id: "t", status: "cancelled" }), defaultPrefs)).toBeNull();
        expect(attentionFor(event("message.created", { id: "m" }), defaultPrefs)).toBeNull();
    });
    it("같은 사건은 여러 탭에서 한 번만 알리고 오래된 기록은 정리한다", () => {
        const storage = memory();
        expect(claimAttention("turn:t", 1000, storage)).toBe(true);
        expect(claimAttention("turn:t", 2000, storage)).toBe(false);
        expect(claimAttention("approval:t", 2000, storage)).toBe(true);
        expect(claimAttention("turn:t", 1000 + 10 * 60_000, storage)).toBe(true);
        storage.setItem("grove.attention.claims", "{broken");
        expect(claimAttention("turn:x", 1, storage)).toBe(true);
    });
});


describe("보고 있는 화면의 상단 알림", () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
    // 화면을 보고 있고, shown의 대화만 화면에 열려 있다.
    const watch = (prefs: object = {}, shown: string[] = []) => {
        const storage = memory();
        storage.setItem("grove.device.prefs", JSON.stringify(prefs));
        vi.stubGlobal("localStorage", storage);
        vi.stubGlobal("window", { innerWidth: 1000 });
        vi.stubGlobal("document", {
            visibilityState: "visible", hasFocus: () => true,
            querySelectorAll: () => shown.map((session) => ({ dataset: { session }, getBoundingClientRect: () => ({ width: 10, height: 10, left: 0, right: 10 }) })),
        });
    };
    const done = event("turn.updated", { id: "t", status: "completed", completion_preview: "최종 답변" });
    const question = { id: "c", turn_id: "t", name: "ask_user", status: "awaiting_input", target: { question: "어느 쪽으로 갈까요?" } };

    it("다른 대화의 답변 완료와 질문을 한 번씩 띄우고 기기 알림 설정과는 따로 판단한다", () => {
        watch({ notifyDone: false, notifyApproval: false });
        notifyAttention(done);
        notifyAttention(done);
        expect(showSessionNotice).toHaveBeenCalledExactlyOnceWith({ id: "turn:t", kind: "done", projectId: "p", sessionId: "s", text: "최종 답변" });
        notifyAttention(event("tool_call.updated", question));
        expect(showSessionNotice).toHaveBeenLastCalledWith({ id: "question:c", kind: "question", projectId: "p", sessionId: "s", text: "어느 쪽으로 갈까요?" });
    });
    it("표시 안 함으로 둔 종류·열어 둔 대화·실패한 턴은 띄우지 않는다", () => {
        watch({ noticeDoneSeconds: 0, noticeQuestionSeconds: 0 });
        notifyAttention(done);
        notifyAttention(event("tool_call.updated", question));
        watch({}, ["s"]);
        notifyAttention(done);
        watch();
        notifyAttention(event("turn.updated", { id: "t", status: "failed" }));
        expect(showSessionNotice).not.toHaveBeenCalled();
    });
    it("답한 질문과 읽은 대화의 완료 알림은 지운다", () => {
        watch();
        notifyAttention(event("tool_call.updated", { ...question, status: "succeeded" }));
        expect(dismissSessionNotice).toHaveBeenCalledExactlyOnceWith("question:c");
        notifyAttention(event("recent.updated", { kind: "session", resource_id: "s", unread: false, completion_unread: true }));
        expect(dismissDoneNotice).not.toHaveBeenCalled();
        notifyAttention(event("recent.updated", { kind: "session", resource_id: "s", unread: false, completion_unread: false }));
        expect(dismissDoneNotice).toHaveBeenCalledExactlyOnceWith("s");
    });
});

describe("읽은 대화의 알림 정리", () => {
    afterEach(() => vi.unstubAllGlobals());
    const shown = async () => {
        const server = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ origin: "https://grove.test" })))),
            (b) => b.toString(16).padStart(2, "0")).join("");
        const close = { done: vi.fn(), unread: vi.fn(), approval: vi.fn(), other: vi.fn() };
        const getNotifications = vi.fn(async () => [
            { tag: `${server}:turn:a`, data: { sessionId: "read", server }, close: close.done },
            { tag: `${server}:turn:b`, data: { sessionId: "unread", server }, close: close.unread },
            { tag: `${server}:approval:c`, data: { sessionId: "read", server }, close: close.approval },
            { tag: `${"b".repeat(64)}:turn:d`, data: { sessionId: "read", server: "b".repeat(64) }, close: close.other },
        ]);
        vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ getNotifications }) } });
        vi.stubGlobal("location", { origin: "https://grove.test" });
        vi.stubGlobal("localStorage", { getItem: () => null });
        return { close, getNotifications };
    };
    const item = (id: string, unread: boolean, completion = false) => ({ kind: "session", resource_id: id, unread, completion_unread: completion });

    it("읽은 대화의 완료·실패 알림만 닫고 승인 요청·다른 서버·안 읽은 대화 알림은 남긴다", async () => {
        const { close } = await shown();
        await closeReadNotifications(async () => [item("read", false), item("unread", false, true)]);
        expect(close.done).toHaveBeenCalledOnce();
        expect(close.unread).not.toHaveBeenCalled();
        expect(close.approval).not.toHaveBeenCalled();
        expect(close.other).not.toHaveBeenCalled();
    });

    it("다른 기기의 읽음 이벤트로도 닫고, 표시된 알림이 없으면 목록을 조회하지 않는다", async () => {
        const { close } = await shown();
        notifyAttention(event("recent.updated", item("read", false)));
        await vi.waitFor(() => expect(close.done).toHaveBeenCalledOnce());
        vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ getNotifications: async () => [] }) } });
        const load = vi.fn(async () => []);
        await closeReadNotifications(load);
        expect(load).not.toHaveBeenCalled();
    });
});

describe("모바일 시스템 알림", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("모바일에서 지원하지 않는 Notification 생성자 대신 worker를 사용하고 진동과 대상만 넘긴다", async () => {
        const showNotification = vi.fn().mockResolvedValue(undefined);
        const Constructor = vi.fn(() => { throw new Error("mobile constructor unsupported"); });
        Object.assign(Constructor, { permission: "granted" });
        vi.stubGlobal("Notification", Constructor);
        vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification }) } });
        vi.stubGlobal("location", { origin: "https://grove.test" });
        vi.stubGlobal("localStorage", { getItem: () => null });
        expect(await showAttention({ kind: "done", title: "작업 완료", body: "끝났습니다", tag: "turn:t", projectId: "p", sessionId: "s" }, false, true)).toBe(true);
        expect(Constructor).not.toHaveBeenCalled();
        expect(showNotification).toHaveBeenCalledWith("작업 완료", expect.objectContaining({ vibrate: [180, 80, 180], data: expect.objectContaining({ projectId: "p", sessionId: "s" }), tag: expect.stringMatching(/^[0-9a-f]{64}:turn:t$/) }));
    });
    it("알림 전달 실패를 성공으로 표시하거나 예외로 전파하지 않는다", async () => {
        vi.stubGlobal("Notification", { permission: "granted" });
        vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => { throw new Error("worker unavailable"); } } });
        expect(await showAttention({ kind: "server", title: "시험", body: "시험", tag: "test", projectId: null, sessionId: null }, false, false)).toBe(false);
    });
});
