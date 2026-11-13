import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, rawGet } from "../api/client";
import { TerminalCapture } from "./TerminalCapture";
import { guardComposition, NO_MODIFIERS, TerminalInput, type Modifiers } from "./terminal/input";
import { TerminalKeys } from "./terminal/TerminalKeys";

type TerminalRow = { id: string; name: string; status: "running" | "exited" | "lost"; exit_code: number | null; reason: string | null; revision: number };

/// 터미널 탭. 실행 중이면 일회용 티켓으로 WebSocket에 붙고, 끝났으면 저장된 화면을 읽기 전용으로 보여 준다.
export function TerminalView({ projectId, terminalId }: { projectId: string; terminalId: string }) {
    const host = useRef<HTMLDivElement>(null);
    const sock = useRef<WebSocket | null>(null);
    const [row, setRow] = useState<TerminalRow | null>(null);
    const [conn, setConn] = useState<"connecting" | "open" | "closed" | "readonly" | "missing" | "error">("connecting");
    const [retry, setRetry] = useState(0);
    const [err, setErr] = useState<string | null>(null);
    const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS);
    const input = useRef<TerminalInput | null>(null);
    const terminal = useRef<XTerm | null>(null);

    const send = (data: string) => {
        const s = sock.current;
        if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: "input", data }));
    };

    useEffect(() => {
        const term = new XTerm({ convertEol: false, cursorBlink: true, fontSize: 13, scrollback: 5000, disableStdin: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current!);
        fit.fit();
        terminal.current = term;
        const keyboard = new TerminalInput(send, setModifiers);
        input.current = keyboard;
        keyboard.reset();
        const removeCompositionGuard = guardComposition(host.current!);
        const paste = (event: ClipboardEvent) => {
            if (!event.clipboardData) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (term.options.disableStdin) return;
            keyboard.paste(event.clipboardData.getData("text/plain"),
                () => confirm("여러 줄을 붙여넣으면 명령이 실행될 수 있어요. 붙여넣을까요?"),
                (text) => term.paste(text));
        };
        const element = host.current!;
        element.addEventListener("paste", paste, true);
        let closed = false;
        const controller = new AbortController();
        let attempt = 0;
        let reconnect: ReturnType<typeof setTimeout> | null = null;
        const failed = (e: unknown) => {
            if (closed) return;
            term.options.disableStdin = true;
            keyboard.reset();
            setErr(e instanceof ApiError ? e.message : "연결 실패");
            setConn("error");
        };

        term.onData((data) => keyboard.data(data));
        const resize = () => {
            fit.fit();
            const s = sock.current;
            if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        };
        const ro = new ResizeObserver(() => resize());
        ro.observe(host.current!);

        const showSaved = async () => {
            const buf = await rawGet(`/terminals/${terminalId}/screen`, { signal: controller.signal });
            if (closed) return;
            term.options.disableStdin = true;
            term.reset();
            term.write(new Uint8Array(buf));
            setConn("readonly");
        };

        const connect = async () => {
            if (closed) return;
            setConn("connecting");
            setErr(null);
            const list = await api.get<{ terminals: TerminalRow[] }>(`/projects/${projectId}/terminals`, { signal: controller.signal });
            if (closed) return;
            const r = list.terminals.find((t) => t.id === terminalId) ?? null;
            setRow(r);
            if (!r) {
                setErr("터미널이 없습니다(삭제됨)");
                setConn("missing");
                return;
            }
            if (r.status !== "running") {
                await showSaved();
                return;
            }
            let url: string;
            try {
                url = (await api.post<{ url: string }>(`/terminals/${terminalId}/ticket`, {}, { signal: controller.signal })).url;
            } catch (e) {
                if (closed) return;
                if (e instanceof ApiError && e.code === "not_running") return void connect();
                throw e;
            }
            if (closed) return;
            const proto = location.protocol === "https:" ? "wss:" : "ws:";
            const ws = new WebSocket(`${proto}//${location.host}${url}`);
            ws.binaryType = "arraybuffer";
            sock.current = ws;
            let first = true;
            ws.onopen = () => {
                if (closed || sock.current !== ws) { ws.close(); return; }
                attempt = 0;
                term.options.disableStdin = false;
                setConn("open");
                ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            };
            ws.onmessage = (ev) => {
                if (closed || sock.current !== ws) return;
                if (typeof ev.data === "string") {
                    const m = JSON.parse(ev.data) as { type: string; code?: number };
                    if (m.type === "reset") first = true;
                    if (m.type === "exit") {
                        sock.current = null;
                        ws.close();
                        void connect().catch(failed);
                    }
                    return;
                }
                // 첫 binary(또는 reset 뒤)는 전체 snapshot이다: 화면을 비우고 다시 그린다.
                if (first) {
                    term.reset();
                    first = false;
                }
                term.write(new Uint8Array(ev.data as ArrayBuffer));
            };
            ws.onclose = () => {
                if (sock.current !== ws || closed) return;
                sock.current = null;
                term.options.disableStdin = true;
                keyboard.reset();
                setConn("closed");
                // 끊기면 잠시 뒤 다시 붙는다(서버가 끝났으면 저장 화면으로 바뀐다).
                attempt += 1;
                reconnect = setTimeout(() => void connect().catch(failed), Math.min(8000, 500 * 2 ** attempt));
            };
        };
        connect().catch(failed);
        return () => {
            closed = true;
            controller.abort();
            if (reconnect !== null) clearTimeout(reconnect);
            ro.disconnect();
            element.removeEventListener("paste", paste, true);
            removeCompositionGuard();
            input.current = null;
            terminal.current = null;
            sock.current?.close();
            sock.current = null;
            term.dispose();
        };
    }, [projectId, terminalId, retry]);

    const kill = async () => {
        if (!confirm("터미널 프로세스를 종료할까요?")) return;
        await api.post(`/terminals/${terminalId}/kill`);
    };
    const statusText =
        conn === "missing" ? "터미널 없음 · 자동 재생성 안 함" : conn === "error" ? "연결 실패 · 자동 실행 안 함"
            : conn === "open" ? "연결됨" : conn === "connecting" ? "연결 중…" : conn === "closed" ? "끊김 · 다시 연결 중"
                : row?.status === "lost" ? "서버 재시작으로 종료됨 · 화면만 복원" : `종료됨${row?.exit_code != null ? ` (코드 ${row.exit_code})` : ""}`;
    return (
        <div className="terminal-view" data-testid="terminal-view" data-conn={conn}>
            <div className="inline small">
                <strong>{row?.name ?? "터미널"}</strong>
                <span className="muted" data-testid="terminal-status">{statusText}</span>
                {row?.status === "running" && <button className="ghost small" onClick={() => void kill()}>종료</button>}
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            {(conn === "missing" || conn === "error") && <button className="ghost small" onClick={() => setRetry((n) => n + 1)}>터미널 다시 확인</button>}
            <div className="term-host" ref={host} />
            <TerminalCapture key={terminalId} terminalId={terminalId} enabled={conn === "open" || conn === "readonly"} />
            {conn === "open" && (
                <TerminalKeys modifiers={modifiers}
                    onToggle={(key) => { input.current?.toggle(key); terminal.current?.focus(); }}
                    onReset={() => { input.current?.reset(); terminal.current?.focus(); }}
                    onKey={(data) => { input.current?.data(data); terminal.current?.focus(); }} />
            )}
        </div>
    );
}
