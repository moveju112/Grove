import { ApiError } from "../api/client";
import { emptyLayout, isValid, type Layout } from "./layout";

type Attempt = { layout: Layout; expected_revision: number; key: string };
type Copy = { format: 1; layout: Layout; revision: number; dirty: boolean; edit: string; attempt?: Attempt };
type Store = Pick<Storage, "getItem" | "setItem">;
type Remote = { layout: unknown; revision: number };
type Options = {
    store: Store;
    get: (signal: AbortSignal) => Promise<Remote>;
    put: (attempt: Attempt, signal: AbortSignal) => Promise<{ revision: number }>;
    newKey: () => string;
    active: () => boolean;
    notice: (message: string) => void;
};

const validRevision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const sameLayout = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b);

// 기존의 배치 JSON도 읽는다. 새 사본만 revision·미반영 여부·원래 요청 키를 함께 보관한다.
function parseCopy(raw: string | null): Copy | null {
    try {
        const v = JSON.parse(raw ?? "null");
        if (isValid(v)) return { format: 1, layout: v, revision: 0, dirty: false, edit: "legacy" };
        if (v?.format !== 1 || !isValid(v.layout) || !validRevision(v.revision)
            || typeof v.dirty !== "boolean" || typeof v.edit !== "string" || !v.edit) return null;
        if (v.attempt !== undefined && (!v.attempt || !v.dirty || !isValid(v.attempt.layout) || !validRevision(v.attempt.expected_revision)
            || typeof v.attempt.key !== "string" || !v.attempt.key)) return null;
        return v;
    } catch { return null; }
}

// 하나의 기기/화면 폭에 속하는 저장 수명. 폐기·로그아웃 뒤의 응답은 사본을 다시 만들지 않는다.
export class LayoutPersistence {
    private copy: Copy | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private controller = new AbortController();
    private busy = false;
    private closed = false;
    private writtenEdit: string | null = null;
    private storageKey: string;

    constructor(public readonly key: string, private options: Options) {
        this.storageKey = `grove.layout.${key}`;
    }

    private active() { return !this.closed && this.options.active(); }
    private notice(message: string) { if (this.active()) this.options.notice(message); }
    private read(): Copy | null {
        try { return parseCopy(this.options.store.getItem(this.storageKey)); }
        catch { return null; }
    }
    private ownsCopy() { return (this.read()?.edit ?? null) === this.writtenEdit; }
    private write(): boolean {
        if (!this.active() || !this.copy) return false;
        try {
            this.options.store.setItem(this.storageKey, JSON.stringify(this.copy));
            this.writtenEdit = this.copy.edit;
            return true;
        } catch {
            this.notice("이 기기에 배치를 보존하지 못했습니다. 저장 공간을 확인하세요.");
            return false;
        }
    }
    private schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 500);
    }

    async restore(): Promise<Layout | null> {
        let local = this.read();
        let remote: Remote | null = null;
        try { remote = await this.options.get(this.controller.signal); }
        catch { /* 통신 실패 시 검증된 로컬 사본을 쓴다. */ }
        if (!this.active()) return null;
        // GET을 기다리는 동안 다른 창에서 저장한 더 최신 사본도 포함한다.
        local = this.read() ?? local;
        let server: Layout | null = null;
        try { if (remote && validRevision(remote.revision) && isValid(remote.layout)) server = remote.layout; }
        catch { /* 잘못된 서버 배치는 복원하지 않는다. */ }
        this.copy = local?.dirty ? local : server && remote ? {
            format: 1, layout: server, revision: remote.revision, dirty: false, edit: this.options.newKey(),
        } : local ?? {
            format: 1, layout: emptyLayout(), revision: validRevision(remote?.revision) ? remote.revision : 0,
            dirty: false, edit: this.options.newKey(),
        };
        this.writtenEdit = local?.edit ?? null;
        if (this.write() && this.copy.dirty) this.schedule();
        return this.copy.layout;
    }

    change(layout: Layout) {
        if (!this.active() || !this.copy) return;
        this.copy = { ...this.copy, layout, dirty: true, edit: this.options.newKey() };
        if (this.write()) this.schedule();
    }

    async flush(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.busy || !this.active() || !this.copy?.dirty) return;
        this.busy = true;
        let rebased = false;
        try {
            while (this.active() && this.copy.dirty) {
                // 응답이 늦은 이전 창은 다른 창이 갱신한 로컬 사본을 덮어쓰지 않는다.
                if (!this.ownsCopy()) return;
                const attempt: Attempt = this.copy.attempt ?? {
                    layout: this.copy.layout, expected_revision: this.copy.revision, key: this.options.newKey(),
                };
                this.copy = { ...this.copy, attempt };
                if (!this.write()) return;
                try {
                    const result = await this.options.put(attempt, this.controller.signal);
                    if (!this.active() || !this.ownsCopy()) return;
                    this.copy = {
                        ...this.copy, revision: result.revision, attempt: undefined,
                        dirty: !sameLayout(this.copy.layout, attempt.layout),
                    };
                    if (!this.write()) return;
                } catch (error) {
                    if (!this.active() || !this.ownsCopy()) return;
                    const current = error instanceof ApiError && error.code === "revision_conflict"
                        ? (error.details as { current?: { revision?: unknown } })?.current : undefined;
                    if (!rebased && validRevision(current?.revision)) {
                        // 기존 배치 정책: 같은 기기 창 사이에는 마지막 저장 우선. CAS 재시도는 한 번만 한다.
                        rebased = true;
                        this.copy = { ...this.copy, revision: current.revision, attempt: undefined };
                        if (!this.write()) return;
                        this.notice("다른 창에서 바뀐 배치를 이 창의 배치로 덮어씁니다");
                        continue;
                    }
                    this.notice("배치를 서버에 저장하지 못했습니다(이 기기에는 보존). 다시 저장해 결과를 확인하세요.");
                    return;
                }
            }
        } finally { this.busy = false; }
    }

    dispose() {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.controller.abort();
    }
}
