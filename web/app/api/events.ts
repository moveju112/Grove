// 이벤트 stream 연결. fetch 기반 SSE로 Authorization 헤더를 보내고(토큰을 URL에 넣지 않음),
// 끊기면 backoff 후 마지막 cursor부터 이어받는다. resync를 받으면 상위가 snapshot을 다시 읽는다.

import type { EventHello, EventRecord } from "./generated";
import { parseContract } from "./validation";
import { accessToken, checkProtocol, isLoggedIn, refresh, setCapabilities } from "./client";
import { Cursor, FrameParser, backoff } from "../state/events";
import { serverTimeZone } from "../state/time";
import { probeResumedTransport, transportFetch } from "./transport";

// 데몬은 평소 15초 간격으로 SSE keep-alive를 보낸다. 평문 HTTP에서는 연결 자체를 새로 확인한다.
const SSE_QUIET_MS = 17_000;

export type StreamHandlers = {
    onEvents: (events: EventRecord[]) => void;
    onPartial: (sessionId: string, snapshot: unknown) => void;
    onServerTimeZone?: (timeZone: string) => void;
    onResync: (kind: "initial" | "reset" | "reconnect" | "subscription") => void;
    /// connecting: 처음 연결 중, live: 연결됨, reconnecting: 끊긴 뒤 다시 연결 중, offline: 끊김(retryAt에 재시도),
    /// auth_expired: 인증이 만료되어 재시도하지 않음.
    onStatus: (s: StreamStatus, retryAt?: number) => void;
};

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline" | "auth_expired";

export class EventStream {
    private cursor = new Cursor();
    private abort: AbortController | null = null;
    private stopped = false;
    private attempt = 0;
    private sessions: string[] = [];
    private everLive = false;
    private wake: (() => void) | null = null;
    private lastByteAt = 0;
    private resumeTimer: ReturnType<typeof setTimeout> | undefined;
    private resumeCheck = 0;
    private wasHidden = false;
    private onOnline = () => this.resume();
    private onVisibility = () => {
        const hidden = document.visibilityState === "hidden";
        const resumed = this.wasHidden && !hidden;
        this.wasHidden = hidden;
        if (hidden) this.cancelResumeCheck();
        if (resumed) this.resume();
    };
    private onPageShow = (event: PageTransitionEvent) => {
        if (event.persisted && !this.wasHidden) this.resume();
    };

    constructor(private h: StreamHandlers) {}

    start(fromCursor: number | null) {
        this.cursor = new Cursor(fromCursor);
        this.stopped = false;
        // 네트워크가 돌아오면 backoff를 기다리지 않고 바로 다시 붙는다.
        if (typeof window !== "undefined") {
            window.addEventListener("online", this.onOnline);
            window.addEventListener("pageshow", this.onPageShow);
        }
        if (typeof document !== "undefined") {
            this.wasHidden = document.visibilityState === "hidden";
            document.addEventListener("visibilitychange", this.onVisibility);
        }
        void this.loop();
    }

    /// 재시도 대기를 끝내고 바로 다시 연결한다(사용자 '지금 재연결'·네트워크 복구).
    retryNow() {
        this.attempt = 0;
        this.wake?.();
    }

    private resume() {
        if (this.stopped || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
        const active = this.abort;
        const waiting = this.wake !== null;
        this.cancelResumeCheck();
        const check = this.resumeCheck;
        this.retryNow();
        if (!active || waiting || this.wasHidden) return;
        const current = () => !this.stopped && !this.wasHidden && this.abort === active
            && !active.signal.aborted && this.resumeCheck === check;
        void probeResumedTransport().then((result) => {
            if (!current()) return;
            const restart = () => {
                if (!current()) return;
                this.cancelResumeCheck();
                if (this.wake) this.retryNow();
                else {
                    this.transportInterrupted = true;
                    this.restartNow = true;
                    active.abort();
                }
            };
            if (result === "dead") restart();
            if (result === "direct") {
                const remaining = SSE_QUIET_MS - (Date.now() - this.lastByteAt);
                if (remaining <= 0) restart();
                // 복귀가 keep-alive 경계보다 빨라도 한번 더 확인한다. 새 byte가 오면 정상 연결이다.
                else this.resumeTimer = setTimeout(restart, remaining);
            }
        });
    }

    private cancelResumeCheck() {
        // 타이머뿐 아니라 아직 응답하지 않은 이전 복귀 검사도 무효화한다.
        this.resumeCheck++;
        clearTimeout(this.resumeTimer);
        this.resumeTimer = undefined;
    }

    /// 상세 stream을 받을 세션 목록 변경(화면에 보이는 세션만, NET-009). 연결을 다시 맺는다.
    setSessions(ids: string[]) {
        const next = [...new Set(ids)].sort();
        if (next.join(",") === this.sessions.join(",")) return;
        this.sessions = next;
        if (this.wake) this.retryNow();
        else if (this.abort) {
            this.restartNow = true;
            this.abort.abort();
        }
    }

    private restartNow = false;
    private transportInterrupted = false;

    stop() {
        this.stopped = true;
        this.cancelResumeCheck();
        if (typeof window !== "undefined") {
            window.removeEventListener("online", this.onOnline);
            window.removeEventListener("pageshow", this.onPageShow);
        }
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
        this.abort?.abort();
        this.wake?.();
    }

    get seq(): number | null {
        return this.cursor.seq;
    }

    private async loop() {
        while (!this.stopped) {
            this.h.onStatus(this.everLive ? "reconnecting" : "connecting");
            this.lastByteAt = Date.now();
            this.abort = new AbortController();
            const signal = this.abort.signal;
            const requireActive = () => {
                if (this.stopped || signal.aborted) throw new DOMException("stream retired", "AbortError");
            };
            let resync = false;
            let reader: ReadableStreamDefaultReader<string> | null = null;
            try {
                const q = new URLSearchParams({ sessions: this.sessions.join(",") });
                if (this.cursor.seq !== null) q.set("cursor", String(this.cursor.seq));
                let token = accessToken();
                let resp = await transportFetch(`/api/v1/events?${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal });
                requireActive();
                if (resp.status === 401 && (await refresh())) {
                    requireActive();
                    token = accessToken();
                    resp = await transportFetch(`/api/v1/events?${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal });
                }
                requireActive();
                checkProtocol(resp);
                if (resp.status === 401) {
                    // 갱신 서버의 일시 오류로 이전 access만 남았다면 backoff로 복구한다.
                    if (isLoggedIn()) throw new Error("events authentication check unavailable");
                    // refresh도 거부됨: 만료. 재시도해도 소용없으므로 멈춘다(로그인 화면이 이유를 안내한다).
                    this.h.onStatus("auth_expired");
                    break;
                }
                if (!resp.ok || !resp.body) throw new Error(`events HTTP ${resp.status}`);
                reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
                const parser = new FrameParser();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (this.stopped || signal.aborted) break;
                    if (done) break;
                    this.lastByteAt = Date.now();
                    this.cancelResumeCheck();
                    const events: EventRecord[] = [];
                    const flush = () => { if (events.length) this.h.onEvents(events.splice(0)); };
                    for (const f of parser.push(value)) {
                        if (resync || this.stopped || signal.aborted) break;
                        if (f.event !== "event") flush();
                        if (f.event === "hello") {
                            const c = JSON.parse(f.data) as EventHello;
                            this.h.onServerTimeZone?.(serverTimeZone(c.server_time_zone));
                            this.attempt = 0;
                            this.h.onStatus("live");
                            setCapabilities(c.capabilities);
                            const full = this.cursor.seq === null;
                            if (full) this.cursor.seq = c.cursor;
                            const kind = full ? (this.everLive ? "reset" : "initial")
                                : this.transportInterrupted ? "reconnect" : "subscription";
                            this.everLive = true;
                            this.transportInterrupted = false;
                            this.h.onResync(kind);
                        } else if (f.event === "event") {
                            try {
                                const e = parseContract("EventRecord", JSON.parse(f.data));
                                if (this.cursor.accept(e.seq)) events.push(e);
                            } catch (error) {
                                flush();
                                throw error;
                            }
                        } else if (f.event === "partial") {
                            const p = JSON.parse(f.data) as { session_id: string; snapshot: unknown };
                            this.h.onPartial(p.session_id, p.snapshot);
                        } else if (f.event === "resync") {
                            resync = true;
                        }
                    }
                    flush();
                    if (resync || this.stopped || signal.aborted) break;
                }
            } catch {
                // 아래에서 재접속
            } finally {
                this.cancelResumeCheck();
                if (reader) {
                    try { await reader.cancel(); }
                    catch { /* 이미 오류·abort로 닫힌 reader의 cancel은 다시 거절될 수 있다. */ }
                    reader.releaseLock();
                }
            }
            if (this.stopped) break;
            if (resync) {
                // 보존 범위 밖: 다음 hello가 기준 cursor를 잡고 snapshot을 한 번만 읽는다.
                this.cursor = new Cursor(null);
                continue;
            }
            if (this.restartNow) {
                // 구독 세션 변경으로 일부러 끊은 경우 즉시 다시 연결한다.
                this.restartNow = false;
                continue;
            }
            const wait = backoff(this.attempt++);
            this.transportInterrupted = true;
            await new Promise<void>((r) => {
                const t = setTimeout(r, wait);
                this.wake = () => {
                    clearTimeout(t);
                    r();
                };
                this.h.onStatus("offline", Date.now() + wait);
            });
            this.wake = null;
        }
    }
}
