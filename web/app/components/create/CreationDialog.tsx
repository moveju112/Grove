import { useEffect, useRef, type ReactNode } from "react";
import "./create.css";

// 기존 dialog 스타일을 유지하면서 배경 조작·초점 이탈·Escape를 한 곳에서 처리한다.
export function CreationDialog({ label, onClose, children, busy = false }: {
    label: string; onClose: () => void; children: ReactNode; busy?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const dialog = ref.current!;
        dialog.showModal();
        return () => {
            dialog.close();
            if (previous?.isConnected) previous.focus();
        };
    }, []);
    return <dialog ref={ref} className="dialog creation-dialog" aria-label={label} aria-modal="true" aria-busy={busy}
        onCancel={(e) => { e.preventDefault(); close.current(); }}
        onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close.current();
        }}>
        {children}
    </dialog>;
}
