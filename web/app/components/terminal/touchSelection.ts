import type { Terminal } from "@xterm/xterm";

/// 손가락을 이 시간만큼 거의 움직이지 않고 누르면 선택을 시작한다. 그 전에 움직이면 xterm 스크롤에 맡긴다.
const HOLD_MS = 450;
const MOVE_SLOP_PX = 10;

type Cell = { col: number; row: number };
type Box = { left: number; top: number; width: number; height: number };

/// 화면 좌표를 버퍼 셀로 바꾼다. 터미널 밖 좌표는 가장자리 셀로 맞춘다.
export function cellAt(box: Box, cols: number, rows: number, viewportY: number, x: number, y: number): Cell {
    const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
    return {
        col: clamp(Math.floor((x - box.left) / (box.width / cols)), cols - 1),
        row: viewportY + clamp(Math.floor((y - box.top) / (box.height / rows)), rows - 1),
    };
}

/// 두 셀 사이(양끝 포함)를 xterm select() 인자로 바꾼다. 순서는 상관없다.
export function selectionRange(a: Cell, b: Cell, cols: number) {
    const [start, end] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    return { column: start.col, row: start.row, length: (end.row - start.row) * cols + end.col - start.col + 1 };
}

/// 모바일 터치로 터미널 출력을 선택한다. 길게 누르면 단어를 선택하고, 손을 떼지 않고 끌면 범위를 늘린다.
/// 손을 떼면 선택한 내용을 onSelect로 넘긴다. touching()은 길게 누르기에서 온 contextmenu를 구분하는 데 쓴다.
export function bindTouchSelection(host: HTMLElement, terminal: Terminal, onSelect: (text: string) => void) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let touch: { id: number; x: number; y: number } | null = null;
    let anchor: { start: Cell; end: Cell } | null = null;
    let lastY = 0;

    const cancelHold = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const screenBox = () => (host.querySelector(".xterm-screen") ?? host).getBoundingClientRect();
    const cellFor = (x: number, y: number) => cellAt(screenBox(), terminal.cols, terminal.rows, terminal.buffer.active.viewportY, x, y);
    const isWordCell = (row: number, col: number) => {
        const cell = terminal.buffer.active.getLine(row)?.getCell(col);
        return !!cell && (cell.getWidth() === 0 || /\S/.test(cell.getChars()));
    };
    const word = (at: Cell) => {
        let start = at.col;
        let end = at.col;
        if (isWordCell(at.row, at.col)) {
            while (start > 0 && isWordCell(at.row, start - 1)) start -= 1;
            while (end < terminal.cols - 1 && isWordCell(at.row, end + 1)) end += 1;
        }
        return { start: { col: start, row: at.row }, end: { col: end, row: at.row } };
    };
    const select = (a: Cell, b: Cell) => {
        const range = selectionRange(a, b, terminal.cols);
        terminal.select(range.column, range.row, range.length);
    };
    const begin = (x: number, y: number) => {
        cancelHold();
        if (!touch || anchor) return;
        anchor = word(cellFor(x, y));
        lastY = y;
        select(anchor.start, anchor.end);
    };
    const extend = (x: number, y: number) => {
        if (!anchor) return;
        // 위·아래 가장자리 밖으로 끌면 한 줄씩 스크롤하며 선택을 이어 간다.
        const box = screenBox();
        if (y < box.top && y <= lastY) terminal.scrollLines(-1);
        else if (y > box.top + box.height && y >= lastY) terminal.scrollLines(1);
        lastY = y;
        const focus = cellFor(x, y);
        const before = focus.row < anchor.start.row || (focus.row === anchor.start.row && focus.col < anchor.start.col);
        select(before ? focus : anchor.start, before ? anchor.end : focus);
    };
    const tracked = (list: TouchList) => touch ? Array.from(list).find((item) => item.identifier === touch!.id) : undefined;

    const start = (event: TouchEvent) => {
        cancelHold();
        anchor = null;
        if (event.touches.length !== 1) { touch = null; return; }
        const point = event.touches[0]!;
        touch = { id: point.identifier, x: point.clientX, y: point.clientY };
        timer = setTimeout(() => begin(touch!.x, touch!.y), HOLD_MS);
    };
    const move = (event: TouchEvent) => {
        const point = tracked(event.changedTouches);
        if (!point) return;
        if (anchor) {
            // 선택 중에는 xterm의 터치 스크롤로 넘기지 않는다.
            event.preventDefault();
            event.stopPropagation();
            extend(point.clientX, point.clientY);
        } else if (Math.hypot(point.clientX - touch!.x, point.clientY - touch!.y) > MOVE_SLOP_PX) {
            cancelHold();
            touch = null;
        }
    };
    const end = (event: TouchEvent) => {
        if (!tracked(event.changedTouches)) return;
        cancelHold();
        touch = null;
        if (!anchor) return;
        anchor = null;
        // 뒤따르는 호환 마우스 이벤트가 방금 만든 선택을 지우지 않게 막는다.
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        const text = terminal.getSelection();
        if (text) onSelect(text);
    };
    const contextMenu = (event: MouseEvent) => {
        if (touch) begin(event.clientX, event.clientY);
    };

    host.addEventListener("touchstart", start, { capture: true, passive: true });
    host.addEventListener("touchmove", move, { capture: true, passive: false });
    host.addEventListener("touchend", end, { capture: true, passive: false });
    host.addEventListener("touchcancel", end, { capture: true, passive: false });
    host.addEventListener("contextmenu", contextMenu, true);
    return {
        touching: () => touch !== null,
        dispose: () => {
            cancelHold();
            host.removeEventListener("touchstart", start, true);
            host.removeEventListener("touchmove", move, true);
            host.removeEventListener("touchend", end, true);
            host.removeEventListener("touchcancel", end, true);
            host.removeEventListener("contextmenu", contextMenu, true);
        },
    };
}
