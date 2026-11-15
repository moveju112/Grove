// 새 버전을 자동 적용해도 되는지 판단한다. 확실하지 않으면 입력이 있다고 보고 사용자 선택을 기다린다.

const edited = new Set<Element>();
let tracking = false;

function textField(element: Element): boolean {
    if (element.closest(".xterm")) return false; // 터미널 입력은 즉시 서버로 전송된다.
    if (element instanceof HTMLTextAreaElement) return true;
    if (element instanceof HTMLInputElement) return !["checkbox", "radio", "range", "color", "button", "submit", "reset", "hidden"].includes(element.type);
    return element instanceof HTMLElement && element.isContentEditable;
}

function filled(element: Element): boolean {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value.trim() !== "";
    return (element.textContent ?? "").trim() !== "";
}

/// 이 문서에서 사용자가 직접 고친 입력을 기억한다.
export function trackPendingInput(): void {
    if (tracking) return;
    tracking = true;
    document.addEventListener("input", (event) => {
        if (event.target instanceof Element && textField(event.target)) edited.add(event.target);
    }, true);
}

/// 설정은 그룹의 미저장 표시를, 나머지는 사용자가 고쳤거나 복원된 내용이 남은 입력을 기준으로 한다.
export function hasPendingInput(): boolean {
    if (document.querySelector('[data-settings-unsaved="true"], dialog[open]')) return true;
    // Astryx는 닫힌 native dialog도 유지한다. aria-modal만으로 열린 작업으로 판정하지 않는다.
    if (Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]:not(dialog)'))
        .some((element) => element.getClientRects().length > 0)) return true;
    for (const element of [...edited]) {
        if (!element.isConnected) { edited.delete(element); continue; }
        if (!element.closest('[data-ui="settings-group"]') && filled(element)) return true;
    }
    return Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable='']"))
        .some((element) => textField(element) && !element.closest('[data-ui="settings-group"]') && filled(element));
}
