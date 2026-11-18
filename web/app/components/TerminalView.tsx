import { Text as GroveText } from "@astryxdesign/core/Text";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, rawGet } from "../api/client";
import { terminalSocket, type TerminalSocket } from "../api/transport";
import { guardComposition, NO_MODIFIERS, TerminalInput, type Modifiers } from "./terminal/input";
import { TerminalKeys } from "./terminal/TerminalKeys";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useServerBlockReason } from "./pwa/lifecycle";
import { terminalAction } from "./pwa/terminalAction";
import { Stack } from "@astryxdesign/core/Stack";
import { terminalLayout } from "./terminal/terminal-layout.stylex";
import { useTerminalClipboard } from "./terminal/useTerminalClipboard";

type TerminalRow = { id: string; name: string; status: "running" | "exited" | "lost"; exit_code: number | null; reason: string | null; revision: number };

/// 터미널 탭. 실행 중이면 일회용 티켓으로 WebSocket에 붙고, 끝났으면 저장된 화면을 읽기 전용으로 보여 준다.
export function TerminalView({ projectId, terminalId, focused }: { projectId: string; terminalId: string; focused: boolean }) {
    const serverBlocked = useServerBlockReason();
    const [inputBlocked, setInputBlocked] = useState<string | null>(null);
    const blockedReason = serverBlocked ?? inputBlocked;
    const host = useRef<HTMLDivElement>(null);
    const sock = useRef<TerminalSocket | null>(null);
    const [conn, setConn] = useState<"connecting" | "open" | "closed" | "readonly" | "missing" | "error">("connecting");
    const [retry, setRetry] = useState(0);
    const [err, setErr] = useState<string | null>(null);
    const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS);
    const input = useRef<TerminalInput | null>(null);
    const terminal = useRef<XTerm | null>(null);
    const { bindClipboard, clipboardUI } = useTerminalClipboard(focused, conn === "open", blockedReason, setInputBlocked);

    const send = (data: string) => {
        const s = sock.current;
        if (s?.readyState === WebSocket.OPEN) terminalAction(() => s.send(JSON.stringify({ type: "input", data })), setInputBlocked);
    };

    useEffect(() => { setInputBlocked(null); }, [serverBlocked]);
    useEffect(() => {
        if (terminal.current) terminal.current.options.disableStdin = conn !== "open" || !!blockedReason;
        if (blockedReason) input.current?.reset();
    }, [conn, blockedReason]);
    useEffect(() => {
        if (focused && conn === "open" && !blockedReason) terminal.current?.focus();
    }, [focused, conn, blockedReason]);

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
        const element = host.current!;
        const removeClipboard = bindClipboard(element, term, keyboard);
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

        term.onData((data) => terminalAction(() => keyboard.data(data), setInputBlocked));
        const resize = () => {
            fit.fit();
            const s = sock.current;
            if (s?.readyState === WebSocket.OPEN) terminalAction(() => s.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })), setInputBlocked);
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
            const ws = terminalSocket(url);
            ws.binaryType = "arraybuffer";
            sock.current = ws;
            let first = true;
            ws.onopen = () => {
                if (closed || sock.current !== ws) { ws.close(); return; }
                attempt = 0;
                term.options.disableStdin = !terminalAction(() => {}, setInputBlocked);
                setConn("open");
                terminalAction(() => ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })), setInputBlocked);
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
            removeClipboard();
            removeCompositionGuard();
            input.current = null;
            terminal.current = null;
            sock.current?.close();
            sock.current = null;
            term.dispose();
        };
    }, [projectId, terminalId, retry, bindClipboard]);

    return (
        <Stack gap={1.5} height="100%" minHeight={0} data-testid="terminal-view" data-conn={conn}>
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {blockedReason && <GroveText as="p" display="block" type="inherit" color="warning" role="status" data-testid="terminal-blocked">
                {blockedReason} 터미널 입력·크기 전송을 멈췄습니다. PTY를 종료하지 않았으며 차단 중 입력은 복구 후 다시 보내지 않습니다.
            </GroveText>}
            {(conn === "missing" || conn === "error") && <ServerActionButton variant="secondary" density="compact" onClick={() => setRetry((n) => n + 1)}>터미널 다시 확인</ServerActionButton>}
            <Stack gap={0} padding={1} xstyle={terminalLayout.host} ref={host} />
            {clipboardUI}
            {conn === "open" && (
                <TerminalKeys modifiers={modifiers} blockedReason={blockedReason}
                    onToggle={(key) => { terminalAction(() => input.current?.toggle(key), setInputBlocked); terminal.current?.focus(); }}
                    onReset={() => { input.current?.reset(); terminal.current?.focus(); }}
                    onKey={(data) => { terminalAction(() => input.current?.data(data), setInputBlocked); terminal.current?.focus(); }} />
            )}
        </Stack>
    );
}
