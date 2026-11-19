import { ApiError, isTransportError } from "../api/client";
import { emptyLayout, isValid, type Layout } from "./layout";

type Attempt = { layout: Layout; expected_revision: number; key: string };
type Copy = { format: 1; layout: Layout; revision: number; dirty: boolean; edit: string; attempt?: Attempt; base?: Layout };
type Store = Pick<Storage, "getItem" | "setItem">;
export type RemoteLayout = { layout: unknown; revision: number };
type Options = {
    store: Store;
    get: (signal: AbortSignal) => Promise<RemoteLayout>;
    put: (attempt: Attempt, signal: AbortSignal) => Promise<{ revision: number }>;
    newKey: () => string;
    active: () => boolean;
    notice: (message: string) => void;
    initial?: () => Layout;
    seed?: (layout: Layout) => boolean;
    merge?: (base: Layout, edited: Layout, remote: Layout) => Layout;
    onRemote?: (layout: Layout) => void;
};

const validRevision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const sameLayout = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b);
const layoutStorageKey = (key: string) => `grove.layout.${key}`;

// 기존의 배치 JSON도 읽는다. 새 사본만 revision·미반영 여부·원래 요청 키를 함께 보관한다.
function parseCopy(raw: string | null): Copy | null {
    try {
        const v = JSON.parse(raw ?? "null");
        if (isValid(v)) return { format: 1, layout: v, revision: 0, dirty: false, edit: "legacy" };
        if (v?.format !== 1 || !isValid(v.layout) || !validRevision(v.revision)
            || typeof v.dirty !== "boolean" || typeof v.edit !== "string" || !v.edit) return null;
        if (v.attempt !== undefined && (!v.attempt || !v.dirty || !isValid(v.attempt.layout) || !validRevision(v.attempt.expected_revision)
            || typeof v.attempt.key !== "string" || !v.attempt.key)) return null;
        if (v.base !== undefined && !isValid(v.base)) return null;
        return v;
    } catch { return null; }
}

export function readStoredLayout(store: Pick<Storage, "getItem">, key: string): Layout | null {
    try { return parseCopy(store.getItem(layoutStorageKey(key)))?.layout ?? null; }
    catch { return null; }
}

// 키 하나의 저장 수명. 폐기·로그아웃 뒤의 응답은 사본을 다시 만들지 않는다.
export class LayoutPersistence {
    private copy: Copy | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private controller = new AbortController();
    private busy = false;
    private closed = false;
    private writtenEdit: string | null = null;
    private pendingRemote: RemoteLayout | null = null;
    private storageKey: string;

    constructor(public readonly key: string, private options: Options) {
        this.storageKey = layoutStorageKey(key);
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

    /// 인증된 Workspace만 호출한다. 검증된 기기 사본을 먼저 보여 주고 restore가 최신 서버 상태를 병합한다.
    restoreLocal(): Layout | null {
        if (!this.active()) return null;
        const local = this.read();
        if (!local) return null;
        this.copy = local;
        this.writtenEdit = local.edit;
        return local.layout;
    }

    async restore(beforeApply?: Promise<void>): Promise<Layout | null> {
        let local = this.read();
        const originalEdit = local?.edit;
        let remote: RemoteLayout | null = null;
        try { remote = await this.options.get(this.controller.signal); }
        catch { /* 통신 실패 시 검증된 로컬 사본을 쓴다. */ }
        // 서버 조회는 즉시 시작하고, 이관/초기값 의존성은 응답 적용에만 사용한다.
        if (beforeApply) await beforeApply;
        if (!this.active()) return null;
        // GET을 기다리는 동안 다른 창에서 저장한 더 최신 사본도 포함한다.
        local = this.read() ?? local;
        let server: Layout | null = null;
        try { if (remote && validRevision(remote.revision) && isValid(remote.layout)) server = remote.layout; }
        catch { /* 잘못된 서버 배치는 복원하지 않는다. */ }
        if (local && (local.dirty || local.edit !== originalEdit)) this.copy = local;
        else if (server && remote) this.copy = { format: 1, layout: server, revision: remote.revision, dirty: false, edit: this.options.newKey() };
        else if (local) this.copy = local;
        else {
            const layout = this.options.initial?.() ?? emptyLayout();
            const dirty = !!this.options.initial && remote?.layout === null && remote.revision === 0 && (this.options.seed?.(layout) ?? true);
            this.copy = {
                format: 1, layout, revision: validRevision(remote?.revision) ? remote.revision : 0, dirty, edit: this.options.newKey(),
                base: this.options.merge && !server ? emptyLayout() : undefined,
            };
        }
        this.writtenEdit = local?.edit ?? null;
        if (this.write() && this.copy.dirty) this.schedule();
        return this.copy.layout;
    }

    change(layout: Layout) {
        if (!this.active() || !this.copy) return;
        const base = this.options.merge ? this.copy.base ?? this.copy.layout : undefined;
        this.copy = { ...this.copy, layout, base, dirty: true, edit: this.options.newKey() };
        if (this.write()) this.schedule();
    }

    acceptRemote(remote: RemoteLayout) {
        if (!this.active() || !this.copy || !validRevision(remote.revision) || remote.revision <= this.copy.revision || !isValid(remote.layout)) return;
        if (this.busy || this.copy.dirty) {
            if (!this.pendingRemote || remote.revision > this.pendingRemote.revision) this.pendingRemote = remote;
            return;
        }
        // 공유 키의 다른 창이 미저장 편집을 보존 중이면 해당 사본은 그대로 둔다.
        const local = this.read();
        this.copy = { format: 1, layout: remote.layout, revision: remote.revision, dirty: false, edit: this.options.newKey() };
        if (!local?.dirty) this.write();
        this.options.onRemote?.(remote.layout);
    }

    snapshot() { return this.copy?.layout; }

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
                    const dirty: boolean = !sameLayout(this.copy.layout, attempt.layout);
                    this.copy = {
                        ...this.copy, revision: result.revision, attempt: undefined, dirty,
                        base: this.options.merge && dirty ? attempt.layout : undefined,
                    };
                    if (!this.write()) return;
                } catch (error) {
                    if (!this.active() || !this.ownsCopy()) return;
                    const current = error instanceof ApiError && error.code === "revision_conflict"
                        ? (error.details as { current?: { revision?: unknown; layout?: unknown } })?.current : undefined;
                    if (!rebased && validRevision(current?.revision)) {
                        rebased = true;
                        if (this.options.merge && isValid(current.layout)) {
                            const layout = this.options.merge(this.copy.base ?? emptyLayout(), this.copy.layout, current.layout);
                            const dirty: boolean = !sameLayout(layout, current.layout);
                            this.copy = { ...this.copy, layout, revision: current.revision, attempt: undefined,
                                base: dirty ? current.layout : undefined, dirty };
                            if (!this.write()) return;
                            this.options.onRemote?.(layout);
                            continue;
                        }
                        this.copy = { ...this.copy, revision: current.revision, attempt: undefined };
                        if (!this.write()) return;
                        this.notice("다른 창에서 바뀐 배치를 이 창의 배치로 덮어씁니다");
                        continue;
                    }
                    if (isTransportError(error, true)) {
                        // 연결 문제는 상단 연결 토스트가 알린다. 같은 요청 키로 간격을 늘려 다시 저장한다.
                        this.retryLater();
                        return;
                    }
                    this.notice("배치를 서버에 저장하지 못했습니다(이 기기에는 보존). 다시 저장해 결과를 확인하세요.");
                    return;
                }
                this.retryDelay = 0;
            }
        } finally {
            this.busy = false;
            if (this.pendingRemote) {
                const remote = this.pendingRemote;
                this.pendingRemote = null;
                this.acceptRemote(remote);
            }
        }
    }

    private retryDelay = 0;
    private retryLater() {
        if (!this.active()) return;
        this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 2_000, 60_000);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.retryDelay);
    }

    dispose() {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.controller.abort();
    }
}
