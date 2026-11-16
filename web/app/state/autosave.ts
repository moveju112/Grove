import { ApiError, newKey } from "../api/client";

export type SavedValue<T> = { value: T; revision: number };
export type SavePhase = "idle" | "saving" | "saved" | "error" | "conflict" | "uncertain";
export type SaveSnapshot<T> = SavedValue<T> & {
    dirty: boolean; phase: SavePhase; message?: string; canRebase: boolean; canRetry: boolean;
};
type Attempt<T> = SavedValue<T> & { key: string; version: number };
function equal(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
        && a.length === b.length && a.every((value, index) => equal(value, b[index]));
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    return Object.keys(left).length === Object.keys(right).length
        && Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

function uncertain(error: unknown): boolean {
    if (!(error instanceof ApiError)) return error instanceof TypeError;
    if ((error.details as { result_unknown?: boolean } | undefined)?.result_unknown === false) return false;
    return error.status === 0 || error.status >= 500 || error.status === 408 || error.code === "result_unknown"
        || (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
}

/** blur·선택으로 확정한 입력만 순서대로 저장한다. 편집 revision·결과 불명 요청의 identity는 유지한다. */
export class Autosave<T> {
    private base: SavedValue<T>;
    private remote: SavedValue<T>;
    private value: T;
    private version = 0;
    private wanted = -1;
    private busy = false;
    private attempt: Attempt<T> | null = null;
    private phase: SavePhase = "idle";
    private message?: string;
    private invalidVersion = -1;
    private listeners = new Set<() => void>();
    private snapshot: SaveSnapshot<T>;

    constructor(initial: SavedValue<T>, private save: (value: T, revision: number, key: string) => Promise<SavedValue<T>>, draft?: SavedValue<T>) {
        this.remote = initial;
        this.base = { value: initial.value, revision: draft?.revision ?? initial.revision };
        this.value = draft?.value ?? initial.value;
        if (draft && draft.revision !== initial.revision && !equal(draft.value, initial.value)) this.phase = "conflict";
        this.snapshot = this.makeSnapshot();
    }
    private makeSnapshot(): SaveSnapshot<T> {
        return { value: this.value, revision: this.base.revision, dirty: !equal(this.value, this.base.value),
            phase: this.phase, message: this.message, canRebase: this.remote.revision > this.base.revision && this.invalidVersion < 0,
            canRetry: this.phase === "uncertain" || (this.phase === "error" && this.invalidVersion < 0) };
    }
    private publish() {
        this.snapshot = this.makeSnapshot();
        this.listeners.forEach((listener) => listener());
    }
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    receive(next: SavedValue<T>) {
        if (next.revision < this.remote.revision || (next.revision === this.remote.revision && equal(next.value, this.remote.value))) return;
        this.remote = next;
        if (!this.busy && !this.snapshot.dirty && !this.attempt) {
            this.base = next;
            this.value = next.value;
        }
        this.publish();
    }
    receiveValue(value: T) {
        if (!equal(value, this.remote.value)) this.receive({ value, revision: this.remote.revision + 1 });
    }
    change = (value: T) => {
        if (equal(value, this.value)) return;
        this.value = value;
        this.version++;
        if (this.phase !== "conflict" && this.phase !== "uncertain" && !this.busy && this.invalidVersion < 0) {
            this.phase = "idle"; this.message = undefined;
        }
        this.publish();
    };
    reject = (message: string) => {
        this.invalidVersion = this.version;
        this.wanted = -1;
        if (this.phase !== "uncertain" && this.phase !== "conflict") {
            this.phase = "error"; this.message = message;
        }
        this.publish();
    };
    commit = () => {
        this.wanted = this.version;
        if (this.phase === "conflict" || this.phase === "uncertain" || this.phase === "error") return;
        this.drain();
    };
    commitValid = () => {
        if (this.invalidVersion >= 0) {
            this.invalidVersion = -1;
            if (this.phase === "error") { this.phase = "idle"; this.message = undefined; }
            this.publish();
        }
        this.commit();
    };
    /** 화면을 떠날 때 남은 입력도 저장하되 실패·결과 불명 요청은 자동 재전송하지 않는다. */
    flush = () => {
        if (this.phase === "idle" || this.phase === "saving") this.commit();
    };
    private drain() {
        if (this.busy || this.wanted !== this.version || this.invalidVersion >= 0 || !this.snapshot.dirty) return;
        void this.send({ value: this.value, revision: this.base.revision, version: this.version, key: newKey() });
    }
    private async send(attempt: Attempt<T>) {
        this.busy = true; this.attempt = attempt;
        this.phase = "saving"; this.message = undefined;
        this.publish();
        try {
            const saved = await this.save(attempt.value, attempt.revision, attempt.key);
            this.base = saved;
            if (saved.revision >= this.remote.revision) this.remote = saved;
            if (this.version === attempt.version) {
                this.base = this.remote;
                this.value = this.remote.value;
            }
            this.attempt = null;
            this.phase = this.version === attempt.version ? "saved" : this.invalidVersion >= 0 ? "error" : "idle";
        } catch (error) {
            this.message = error instanceof Error ? error.message : "저장하지 못했어요.";
            if (error instanceof ApiError && error.code === "revision_conflict") {
                this.phase = "conflict"; this.attempt = null;
            } else if (uncertain(error)) this.phase = "uncertain";
            else { this.phase = "error"; this.attempt = null; }
        } finally {
            this.busy = false;
            this.publish();
        }
        if (this.phase === "saved" || this.phase === "idle") this.drain();
    }
    useRemote = () => {
        if (this.busy || this.attempt) return;
        this.base = this.remote; this.value = this.remote.value;
        this.version++; this.wanted = -1;
        this.invalidVersion = -1;
        this.phase = "idle"; this.message = undefined;
        this.publish();
    };
    applyMine = () => {
        if (this.busy || this.attempt || !this.snapshot.canRebase) return;
        this.base = this.remote;
        this.phase = "idle"; this.message = undefined;
        this.publish();
        this.commit();
    };
    retry = () => {
        if (!this.busy && this.phase === "uncertain" && this.attempt) void this.send(this.attempt);
        else if (!this.busy && this.phase === "error" && this.snapshot.canRetry) {
            this.phase = "idle"; this.message = undefined;
            this.publish(); this.commit();
        }
    };
}
