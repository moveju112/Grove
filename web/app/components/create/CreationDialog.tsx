import { useEffect, useRef, type ReactNode } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { usePaneVisible } from "../../state/paneVisibility";

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

// 표면·중첩 레이어·Escape·초점 복귀는 Astryx가 소유한다.
export function CreationDialog({ label, onClose, children, footer, busy = false, width = "36em", isOpen = true }: {
    label: string; onClose: () => void; children: ReactNode; footer?: ReactNode; busy?: boolean; width?: number | string; isOpen?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const visible = usePaneVisible();
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        if (!visible) {
            close.current();
            return;
        }
        const dialog = ref.current!;
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
        };
    }, [visible]);
    return <Dialog ref={ref} isOpen={visible && isOpen} width={width} maxHeight="calc(100dvh - 24px)" padding={4}
        aria-label={label} aria-busy={busy} onOpenChange={(open) => { if (!open) close.current(); }}>
        <StackItem size="fill" isScrollable aria-label={`${label} 내용`}>
            <Stack gap={2}>{children}</Stack>
        </StackItem>
        {footer && <StackItem size="static"><Stack gap={2} paddingBlockStart={2}>{footer}</Stack></StackItem>}
    </Dialog>;
}
