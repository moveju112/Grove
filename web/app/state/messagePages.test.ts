import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessagePage } from "../api/generated";
import { api, authGeneration } from "../api/client";
import { mergeMessagePages, readAroundMessage, readMessagePage } from "./messagePages";

vi.mock("../api/client", () => ({ api: { get: vi.fn() }, authGeneration: vi.fn() }));
const get = vi.mocked(api.get);
const row = (seq: number) => ({ id: String(seq), seq } as Message);
const page = (seqs: number[], revision = 1): MessagePage => ({ items: seqs.map(row), timeline_revision: revision,
    has_more_before: true, has_more_after: true, rewind_boundary_seq: null });
beforeEach(() => { get.mockReset(); vi.mocked(authGeneration).mockReturnValue(1); });

describe("이전·이후 메시지 조회", () => {
    it("같은 커서의 동시 요청을 합치고 인증 세대는 분리한다", async () => {
        let resolve!: (p: MessagePage) => void;
        get.mockImplementation(() => new Promise((r) => { resolve = r; }));
        const first = readMessagePage("s", "before_seq=3");
        expect(readMessagePage("s", "before_seq=3")).toBe(first);
        resolve(page([1, 2]));
        await first;
        get.mockResolvedValue(page([]));
        vi.mocked(authGeneration).mockReturnValue(2);
        await readMessagePage("s", "before_seq=3");
        expect(get).toHaveBeenCalledTimes(2);
    });

    it("목적지 양쪽을 동시에 읽고 중복을 제거한다", async () => {
        get.mockResolvedValueOnce(page([7, 8, 9])).mockResolvedValueOnce(page([9, 10, 11]));
        const result = readAroundMessage("s", 9, 1);
        expect(get.mock.calls).toEqual([["/sessions/s/messages?limit=51&before_seq=10"], ["/sessions/s/messages?limit=50&after_seq=9"]]);
        expect((await result)?.items.map((m) => m.seq)).toEqual([7, 8, 9, 10, 11]);
        expect(mergeMessagePages([row(3)], [row(1), row(3)]).map((m) => m.seq)).toEqual([1, 3]);
    });

    it("되감기로 revision이 달라지면 섞지 않고, 삭제된 목적지는 인접 메시지로 대체하지 않는다", async () => {
        get.mockResolvedValueOnce(page([9])).mockResolvedValueOnce(page([10], 2));
        expect(await readAroundMessage("s", 9, 1)).toBeUndefined();
        get.mockResolvedValueOnce(page([8])).mockResolvedValueOnce(page([10]));
        expect(await readAroundMessage("s", 9, 1)).toBeNull();
    });
});
