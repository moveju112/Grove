// 열린 탭의 입력만 메모리에 둔다. 컴포넌트 재배치는 보존하지만 디스크에는 쓰지 않는다.
type Update<T> = T | ((value: T) => T);

class Cell<T> {
    private listeners = new Set<() => void>();
    constructor(private value: T, readonly active: () => boolean) {}
    read = () => this.value;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    set = (update: Update<T>) => {
        if (!this.active()) return;
        const next = typeof update === "function" ? (update as (value: T) => T)(this.value) : update;
        if (Object.is(next, this.value)) return;
        this.value = next;
        for (const listener of this.listeners) listener();
    };
}

export class ComposerMemory {
    private cells = new Map<string, { copyId: string; cell: Cell<unknown>; location: { key: string } }>();

    cell<T>(resource: string, copyId: string, field: string, initial: () => T): Cell<T> {
        const key = JSON.stringify([resource, copyId, field]);
        const existing = this.cells.get(key);
        if (existing) return existing.cell as Cell<T>;
        const location = { key };
        const cell: Cell<T> = new Cell(initial(), () => this.cells.get(location.key)?.cell === cell);
        this.cells.set(key, { copyId, cell: cell as Cell<unknown>, location });
        return cell;
    }

    move(from: string, to: string, copyId: string) {
        for (const [key, entry] of [...this.cells]) {
            const [resource, copy, field] = JSON.parse(key) as string[];
            if (resource !== from || copy !== copyId) continue;
            this.cells.delete(key);
            entry.location.key = JSON.stringify([to, copyId, field]);
            this.cells.set(entry.location.key, entry);
        }
    }

    retain(copies: ReadonlySet<string>) {
        for (const [key, entry] of this.cells) if (!copies.has(entry.copyId)) this.cells.delete(key);
    }
}
