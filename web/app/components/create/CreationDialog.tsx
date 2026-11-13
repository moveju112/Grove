import { useEffect, useRef, type ReactNode } from "react";
import "./create.css";

// native modal도 마지막 Tab에서 브라우저 UI로 초점을 넘길 수 있어 양 끝을 명시적으로 순환한다.
export function containCreationTab(dialog: HTMLDialogElement, event: KeyboardEvent) {
    if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const controls = [...dialog.querySelectorAll<HTMLElement>("a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]")]
        .filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && !node.closest("[hidden], [inert]")
            && node.getClientRects().length > 0 && dialog.ownerDocument.defaultView!.getComputedStyle(node).visibility === "visible")
        .sort((a, b) => (a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER));
    const first = controls[0];
    const last = controls.at(-1);
    const active = dialog.ownerDocument.activeElement;
    if (!first || !last) {
        event.preventDefault();
        dialog.focus();
    } else if (!controls.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    }
}

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
        const contain = (event: KeyboardEvent) => {
            if (!dialog.open || !dialog.matches(":modal")) return;
            const activeModal = document.activeElement?.closest("dialog:modal");
            if (activeModal && activeModal !== dialog) return;
            containCreationTab(dialog, event);
        };
        // 비동기 상태 변경으로 활성 버튼이 제거·비활성화되어 body로 옮겨져도 다음 Tab을 회수한다.
        document.addEventListener("keydown", contain);
        return () => {
            document.removeEventListener("keydown", contain);
            dialog.close();
            if (previous?.isConnected) previous.focus();
        };
    }, []);
    return <dialog ref={ref} tabIndex={-1} className="dialog creation-dialog" aria-label={label} aria-modal="true" aria-busy={busy}
        onCancel={(e) => { e.preventDefault(); close.current(); }}
        onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close.current();
        }}>
        {children}
    </dialog>;
}
