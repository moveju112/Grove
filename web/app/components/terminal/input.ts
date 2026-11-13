export type Modifiers = { ctrl: boolean; alt: boolean };
export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

export const AUXILIARY_KEYS = [
    ["Esc", "\x1b"],
    ["Tab", "\t"],
    ["↑", "\x1b[A"],
    ["↓", "\x1b[B"],
    ["←", "\x1b[D"],
    ["→", "\x1b[C"],
] as const;

/** 한 번의 입력에서 첫 키에만 보조키를 적용한다. xterm의 기존 키 시퀀스는 그대로 둔다. */
export function applyModifiers(data: string, { ctrl, alt }: Modifiers): string {
    if (!data || (!ctrl && !alt)) return data;
    const arrow = /^(?:\x1b\[|\x1bO)([ABCD])$/.exec(data);
    if (arrow) return `\x1b[1;${1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${arrow[1]}`;
    const first = Array.from(data)[0]!;
    let key = first;
    if (ctrl) {
        const code = first.charCodeAt(0);
        if (code >= 97 && code <= 122) key = String.fromCharCode(code - 96);
        else if (code >= 64 && code <= 95) key = String.fromCharCode(code - 64);
        else if (first === " ") key = "\x00";
        else if (first === "?") key = "\x7f";
    }
    return (alt ? "\x1b" : "") + key + data.slice(first.length);
}

/** xterm의 onData만 PTY로 전달한다. 조합 문자열을 별도로 보내면 확정 입력이 중복된다. */
export class TerminalInput {
    private modifiers: Modifiers = { ...NO_MODIFIERS };
    private pasting = false;

    constructor(
        private readonly send: (data: string) => void,
        private readonly changed: (modifiers: Modifiers) => void,
    ) {}

    toggle(key: keyof Modifiers) {
        this.modifiers = { ...this.modifiers, [key]: !this.modifiers[key] };
        this.changed(this.modifiers);
    }

    reset() {
        this.modifiers = { ...NO_MODIFIERS };
        this.changed(this.modifiers);
    }

    data(data: string) {
        if (!data) return;
        if (this.pasting) {
            this.send(data);
            return;
        }
        const out = applyModifiers(data, this.modifiers);
        this.reset();
        this.send(out);
    }

    paste(text: string, confirm: () => boolean, paste: (text: string) => void): boolean {
        if (!text || (/[\r\n]/.test(text) && !confirm())) return false;
        // xterm.paste가 줄바꿈 정규화와 현재 모드에 맞는 bracketed paste를 담당한다.
        // 붙여넣기는 다음 '키'가 아니므로 대기 중인 Ctrl/Alt를 소모하지 않는다.
        this.pasting = true;
        try {
            paste(text);
        } finally {
            this.pasting = false;
        }
        return true;
    }
}

/** xterm의 조합 UI·확정 타이밍은 유지하되, 브라우저의 input 경로가 중복 전송하지 않게 한다. */
export function guardComposition(host: HTMLElement): () => void {
    const capture = { capture: true };
    let composing = false;
    let settling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
        composing = true;
        settling = false;
        clearTimeout(timer);
    };
    const end = () => {
        composing = false;
        settling = true;
        // compositionend 뒤 같은 이벤트 묶음의 insertText도 xterm의 조합 확정에 포함된다.
        timer = setTimeout(() => { settling = false; }, 0);
    };
    const input = (event: Event) => {
        const e = event as InputEvent;
        if (composing || settling || e.isComposing || e.inputType === "insertFromComposition") {
            e.stopImmediatePropagation();
        }
    };
    host.addEventListener("compositionstart", start, capture);
    host.addEventListener("compositionend", end, capture);
    host.addEventListener("input", input, capture);
    return () => {
        clearTimeout(timer);
        host.removeEventListener("compositionstart", start, capture);
        host.removeEventListener("compositionend", end, capture);
        host.removeEventListener("input", input, capture);
    };
}
