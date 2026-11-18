// 이벤트 stream 연결. fetch 기반 SSE로 Authorization 헤더를 보내고(토큰을 URL에 넣지 않음),
// 끊기면 backoff 후 마지막 cursor부터 이어받는다. resync를 받으면 상위가 snapshot을 다시 읽는다.

import type { EventRecord } from "./generated";
import { parseContract } from "./validation";
import { accessToken, checkProtocol, isLoggedIn, refresh, setCapabilities } from "./client";
import { Cursor, FrameParser, backoff } from "../state/events";
import { transportFetch } from "./transport";

export type StreamHandlers = {
    onEvent: (e: EventRecord) => void;
    onPartial: (sessionId: string, snapshot: unknown) => void;
    onResync: () => void;
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
    private onOnline = () => this.retryNow();

    constructor(private h: StreamHandlers) {}

    start(fromCursor: number | null) {
        this.cursor = new Cursor(fromCursor);
        this.stopped = false;
        // 네트워크가 돌아오면 backoff를 기다리지 않고 바로 다시 붙는다.
        if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
        void this.loop();
    }

    /// 재시도 대기를 끝내고 바로 다시 연결한다(사용자 '지금 재연결'·네트워크 복구).
    retryNow() {
        this.attempt = 0;
        this.wake?.();
    }

    /// 상세 stream을 받을 세션 목록 변경(화면에 보이는 세션만, NET-009). 연결을 다시 맺는다.
    setSessions(ids: string[]) {
        const next = [...new Set(ids)].sort();
        if (next.join(",") === this.sessions.join(",")) return;
        this.sessions = next;
        this.restartNow = true;
        this.abort?.abort();
    }

    private restartNow = false;

    stop() {
        this.stopped = true;
        if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
        this.abort?.abort();
        this.wake?.();
    }

    get seq(): number | null {
        return this.cursor.seq;
    }

    private async loop() {
        while (!this.stopped) {
            this.h.onStatus(this.everLive ? "reconnecting" : "connecting");
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
                    for (const f of parser.push(value)) {
                        if (resync || this.stopped || signal.aborted) break;
                        if (f.event === "hello") {
                            this.attempt = 0;
                            this.everLive = true;
                            this.h.onStatus("live");
                            const c = JSON.parse(f.data) as { cursor: number; capabilities?: unknown };
                            setCapabilities(c.capabilities);
                            if (this.cursor.seq === null) {
                                this.cursor.seq = c.cursor;
                            }
                            // partial 삭제는 cursor로 재생되지 않는다. 접속마다 이전 임시 응답을
                            // 비우고 확정 상태를 다시 읽은 뒤, 이 연결의 최신 snapshot만 받는다.
                            this.h.onResync();
                        } else if (f.event === "event") {
                            const e = parseContract("EventRecord", JSON.parse(f.data));
                            if (this.cursor.accept(e.seq)) this.h.onEvent(e);
                        } else if (f.event === "partial") {
                            const p = JSON.parse(f.data) as { session_id: string; snapshot: unknown };
                            this.h.onPartial(p.session_id, p.snapshot);
                        } else if (f.event === "resync") {
                            resync = true;
                        }
                    }
                    if (resync || this.stopped || signal.aborted) break;
                }
            } catch {
                // 아래에서 재접속
            } finally {
                if (reader) {
                    try { await reader.cancel(); }
                    catch { /* 이미 오류·abort로 닫힌 reader의 cancel은 다시 거절될 수 있다. */ }
                    reader.releaseLock();
                }
            }
            if (this.stopped) break;
            if (resync) {
                // 보존 범위 밖: 최신부터 다시 받고 상위가 snapshot을 재조회한다.
                this.cursor = new Cursor(null);
                this.h.onResync();
                continue;
            }
            if (this.restartNow) {
                // 구독 세션 변경으로 일부러 끊은 경우 즉시 다시 연결한다.
                this.restartNow = false;
                continue;
            }
            const wait = backoff(this.attempt++);
            this.h.onStatus("offline", Date.now() + wait);
            await new Promise<void>((r) => {
                const t = setTimeout(r, wait);
                this.wake = () => {
                    clearTimeout(t);
                    r();
                };
            });
            this.wake = null;
        }
    }
}
