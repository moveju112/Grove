import { useRef, useState } from "react";
import { ApiError, newKey } from "../api/client";

/** 결과 불명인 저장은 입력·키를 고정하고, 같은 요청으로 접수 여부를 확인한다. */
export function useReceiptMutation<B, T extends object>(send: (body: B, key: string) => Promise<T>) {
    const sending = useRef(false);
    const attempt = useRef<{ body: B; key: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (body: B): Promise<T | null> => {
        if (sending.current) return null;
        sending.current = true;
        setBusy(true);
        setError(null);
        const request = attempt.current ?? { body, key: newKey() };
        attempt.current = request;
        try {
            const result = await send(request.body, request.key);
            attempt.current = null;
            setPending(false);
            return result;
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || e.code === "result_unknown" || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            if (!unknown) attempt.current = null;
            setPending(unknown);
            setError(e instanceof Error ? e.message : "요청 결과를 확인하지 못했어요");
            return null;
        } finally {
            sending.current = false;
            setBusy(false);
        }
    };
    return { submit, busy, pending, error, blocked: busy || pending };
}
