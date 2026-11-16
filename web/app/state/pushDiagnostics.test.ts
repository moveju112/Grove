import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushRegistration } from "./webPush";
import { pushBrowserMessage, readPushBrowserStatus, type PushBrowserStatus } from "./pushDiagnostics";

vi.mock("./webPush", () => ({ pushRegistration: vi.fn() }));
const postMessage = vi.fn();
let reply: unknown;
let port: { onmessage: ((event: { data: unknown }) => void) | null; onmessageerror: (() => void) | null; close: ReturnType<typeof vi.fn> };

describe("기기의 실제 Push 수신 기록 조회", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        port = { onmessage: null, onmessageerror: null, close: vi.fn() };
        vi.stubGlobal("MessageChannel", class {
            port1 = port;
            port2 = { close: vi.fn() };
        });
        reply = { type: "push-test-status", testId: "t", version: "current", receipt: null, storageError: false };
        postMessage.mockImplementation(() => queueMicrotask(() => port.onmessage?.({ data: reply })));
        vi.mocked(pushRegistration).mockResolvedValue({ active: { postMessage } } as unknown as ServiceWorkerRegistration);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it("현재 등록의 활성 워커에 개별 MessagePort로 조회하고 포트를 정리한다", async () => {
        expect(await readPushBrowserStatus("t")).toEqual({ version: "current", receipt: null, storageError: false });
        expect(postMessage).toHaveBeenCalledWith({ type: "push-test-status", testId: "t" }, [expect.anything()]);
        expect(port.close).toHaveBeenCalledOnce();
    });
    it("등록 결과와 오류 코드가 포함된 수신 기록을 읽는다", async () => {
        reply = { type: "push-test-status", testId: "t", version: "current", storageError: false,
            receipt: { stage: "display_failed", error: "NotAllowedError", version: "recorded", at: 10 } };
        const status = await readPushBrowserStatus("t");
        expect(pushBrowserMessage(status)).toContain("수신 후 알림 등록 실패 (NotAllowedError)");
    });
    it("다른 시험의 응답이나 알 수 없는 상태를 정상 기록으로 처리하지 않는다", async () => {
        reply = { type: "push-test-status", testId: "other", version: "current", receipt: null, storageError: false };
        await expect(readPushBrowserStatus("t")).rejects.toThrow("응답을 확인하지 못했어");
        reply = { type: "push-test-status", testId: "t", version: "current", storageError: false,
            receipt: { stage: "displayed", error: null, version: "current", at: 10 } };
        await expect(readPushBrowserStatus("t")).rejects.toThrow("응답을 확인하지 못했어");
    });
    it("구버전 워커의 무응답은 조회 실패로 구분하고 미수신으로 단정하지 않는다", async () => {
        vi.useFakeTimers();
        postMessage.mockImplementation(() => undefined);
        const check = expect(readPushBrowserStatus("t")).rejects.toThrow("이전 서비스 워커");
        await vi.advanceTimersByTimeAsync(5000);
        await check;
        expect(port.close).toHaveBeenCalledOnce();
    });
    it("조회·저장 실패와 기록 없음, 수신·등록 성공을 구분한다", () => {
        const empty: PushBrowserStatus = { version: "current", receipt: null, storageError: false };
        expect(pushBrowserMessage(empty)).toContain("미수신을 확정할 수는 없어");
        expect(pushBrowserMessage({ ...empty, storageError: true })).toContain("저장·조회에 실패");
        expect(pushBrowserMessage({ ...empty, receipt: { stage: "registered", error: null, version: "current", at: 10 } }))
            .toContain("수신·알림 등록 확인됨. 실제 화면 표시는 별도");
    });
});
