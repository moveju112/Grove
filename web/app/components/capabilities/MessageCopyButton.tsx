import { useCallback, useEffect, useState } from "react";
import { copyMessageText } from "./browser";
import { Icon } from "../icons";

// 표시용 Markdown이 아닌 메시지 원문을 복사한다.
export function MessageCopyButton({ text }: { text: string }) {
    const [done, setDone] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const select = useCallback((node: HTMLTextAreaElement | null) => {
        if (node) { node.focus(); node.select(); }
    }, []);
    useEffect(() => {
        if (!done) return;
        const timer = setTimeout(() => setDone(false), 1500);
        return () => clearTimeout(timer);
    }, [done]);
    return <span>
        <button className="ghost icon-btn msg-copy" data-testid="msg-copy" disabled={busy} aria-label={done ? "복사됨" : "메시지 복사"} title={done ? "복사됨" : "메시지 복사"} onClick={async () => {
            setBusy(true);
            setDone(false);
            const result = await copyMessageText(text);
            setBusy(false);
            setDone(result.copied);
            setMessage(result.message ?? null);
        }}><Icon name={done ? "check" : "copy"} size={16} /></button>
        {message && <span className="small">
            <span role="status">{message}</span>
            <textarea aria-label="메시지 원문 수동 복사" readOnly value={text} rows={4}
                ref={select} onFocus={(e) => e.currentTarget.select()} />
            <button className="ghost small" onClick={() => setMessage(null)}>수동 복사 닫기</button>
        </span>}
    </span>;
}
