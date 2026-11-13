import { ApiError } from "../../api/client";
import { requireServerAction } from "./lifecycle";

/** PTY 연결은 유지하고 지금의 입력·resize만 버린다. 복구 시 재전송할 사본은 만들지 않는다. */
export function terminalAction(action: () => void, blocked: (reason: string) => void): boolean {
    try {
        requireServerAction();
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        blocked(error.message);
        return false;
    }
    action();
    return true;
}
