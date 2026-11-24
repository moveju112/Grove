import { afterEach, expect, it, vi } from "vitest";
import type { Message, MessagePage, Turn } from "../api/generated";
import { acceptSent, acceptedInFollowups, acceptedInMessages, addOutgoing, clearOutgoing, outgoingResource, readOutgoing, removeOutgoing } from "./outgoing";
import { clearServerCache, querySnapshot, seedQuery, subscribeQuery } from "./store";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const message = (seq: number, text: string, id = `m${seq}`): Message =>
    ({ id, session_id: "s1", seq, role: "user", content: { text }, turn_id: null, created_at: "2026-01-01T00:00:00Z" });
const page = (items: Message[]): MessagePage =>
    ({ items, has_more_before: false, has_more_after: false, timeline_revision: 0, rewind_boundary_seq: null });

afterEach(() => { clearOutgoing(); clearServerCache(); });

it("대화의 임시 메시지는 그 대화를 보는 모든 영역이, 새 대화의 임시 메시지는 그 탭만 본다", () => {
    expect(outgoingResource("session:s1", "tab-a")).toBe("session:s1");
    expect(outgoingResource("project:p1", "tab-a")).toBe("project:p1#tab-a");
});

it("보낸 글은 응답 전에 보이고 같은 글이 서버 목록에 나타나면 겹쳐 보이지 않는다", async () => {
    const off = subscribeQuery("messages:s1", async () => page([message(1, "이전 글")]), () => undefined);
    try {
        await settle();
        addOutgoing({ key: "k1", resource: "session:s1", copyId: "tab", text: "이전 글", files: [] });
        const [entry] = readOutgoing("session:s1");
        expect(entry).toMatchObject({ key: "k1", afterSeq: 1 });
        // 보내기 전에 있던 같은 글은 방금 보낸 글이 아니다.
        expect(acceptedInMessages(entry!, [message(1, "이전 글")])).toBe(false);
        expect(acceptedInMessages(entry!, [message(1, "이전 글"), message(2, "이전 글")])).toBe(true);
        removeOutgoing("k1");
        expect(readOutgoing("session:s1")).toEqual([]);
    } finally { off(); }
});

it("실행 중에 보낸 추가 메시지는 보내기 전에 없던 같은 대기 항목이 생기면 접수된 것으로 본다", async () => {
    const off = subscribeQuery("followups:s1", async () => ({ items: [{ id: "f1", kind: "queue", text: "다음 일" }] }), () => undefined);
    try {
        await settle();
        addOutgoing({ key: "k2", resource: "session:s1", copyId: "tab", text: "다음 일", files: [], follow: "queue" });
        const [entry] = readOutgoing("session:s1");
        expect(acceptedInFollowups(entry!, [{ id: "f1", kind: "queue", text: "다음 일" }])).toBe(false);
        expect(acceptedInFollowups(entry!, [{ id: "f1", kind: "queue", text: "다음 일" }, { id: "f2", kind: "queue", text: "다음 일" }])).toBe(true);
    } finally { off(); }
});

it("전송 응답의 메시지·실행을 바로 반영하고 그 전에 시작한 조회 결과로 되돌리지 않는다", async () => {
    let finish!: (value: MessagePage) => void;
    const get = vi.fn(() => new Promise<MessagePage>((resolve) => { finish = resolve; }));
    const offMessages = subscribeQuery("messages:s1", get, () => undefined);
    const offTurns = subscribeQuery("turns:s1", async () => [] as Turn[], () => undefined);
    try {
        finish(page([message(1, "첫 글")]));
        await settle();
        // 전송 전에 시작한 재조회가 아직 끝나지 않았다.
        const { invalidate } = await import("./store");
        invalidate("messages:s1");
        expect(get).toHaveBeenCalledTimes(2);
        const stale = finish;
        acceptSent("s1", { message: message(2, "보낸 글"), turn: { id: "t1", status: "queued" } as Turn });
        expect(querySnapshot<MessagePage>("messages:s1").data?.items.map((item) => item.seq)).toEqual([1, 2]);
        expect(querySnapshot<Turn[]>("turns:s1").data?.map((turn) => turn.id)).toEqual(["t1"]);
        stale(page([message(1, "첫 글")]));
        await settle();
        expect(querySnapshot<MessagePage>("messages:s1").data?.items.map((item) => item.seq)).toEqual([1, 2]);
        expect(get).toHaveBeenCalledTimes(3);
        finish(page([message(1, "첫 글"), message(2, "보낸 글")]));
        await settle();
        // 이미 있는 메시지·실행은 다시 넣지 않는다.
        acceptSent("s1", { message: message(2, "보낸 글"), turn: { id: "t1", status: "queued" } as Turn });
        expect(querySnapshot<MessagePage>("messages:s1").data?.items).toHaveLength(2);
        expect(querySnapshot<Turn[]>("turns:s1").data).toHaveLength(1);
    } finally { offMessages(); offTurns(); }
});

it("미리 채운 조회는 값을 바로 보이고 화면이 구독할 때 한 번 다시 읽는다", async () => {
    const get = vi.fn(async () => "서버 값");
    seedQuery("session:new", "응답 값", get);
    expect(querySnapshot("session:new").data).toBe("응답 값");
    expect(get).not.toHaveBeenCalled();
    const off = subscribeQuery("session:new", get, () => undefined);
    try {
        expect(querySnapshot("session:new").data).toBe("응답 값");
        await settle();
        expect(get).toHaveBeenCalledTimes(1);
        expect(querySnapshot("session:new").data).toBe("서버 값");
        // 이미 조회한 항목은 덮어쓰지 않는다.
        seedQuery("session:new", "늦은 값", get);
        expect(querySnapshot("session:new").data).toBe("서버 값");
    } finally { off(); }
});
