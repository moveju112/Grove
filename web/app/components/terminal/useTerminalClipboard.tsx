import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "../../design/Button";
import { loadPrefs, savePrefs } from "../../state/device";
import { copyMessageText } from "../capabilities/browser";
import { CreationDialog } from "../create/CreationDialog";
import { terminalAction } from "../pwa/terminalAction";
import { ServerActionButton } from "../pwa/ServerActionButton";
import type { TerminalInput } from "./input";

type PendingPaste = { terminal: Terminal; apply: () => void };

export function useTerminalClipboard(focused: boolean, connected: boolean, blockedReason: string | null, onBlocked: (reason: string) => void) {
    const activity = useRef({ focused, connected, blockedReason, version: 0 });
    if (activity.current.focused !== focused || activity.current.connected !== connected || activity.current.blockedReason !== blockedReason) {
        activity.current = { focused, connected, blockedReason, version: activity.current.version + 1 };
    }
    const pending = useRef<PendingPaste | null>(null);
    const [confirmation, setConfirmation] = useState<PendingPaste | null>(null);
    const [dontAsk, setDontAsk] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dismiss = useCallback(() => {
        pending.current = null;
        setConfirmation(null);
        setDontAsk(false);
    }, []);
    useEffect(() => {
        if (!focused || !connected || blockedReason) dismiss();
    }, [focused, connected, blockedReason, dismiss]);

    const bindClipboard = useCallback((host: HTMLElement, terminal: Terminal, input: TerminalInput) => {
        let closed = false;
        let selecting = false;
        let reading = false;
        const writable = (version = activity.current.version) => !closed && activity.current.focused && activity.current.connected
            && !activity.current.blockedReason && version === activity.current.version && !terminal.options.disableStdin;
        const apply = (text: string, version: number) => {
            if (!writable(version)) return;
            terminalAction(() => {
                input.paste(text, () => true, (value) => terminal.paste(value));
            }, onBlocked);
        };
        const requestPaste = (text: string, version = activity.current.version) => {
            if (!text || !writable(version) || pending.current) return;
            if (!terminalAction(() => {}, onBlocked)) return;
            setError(null);
            if (/[\r\n]/.test(text) && loadPrefs().confirmTerminalPaste) {
                const request = { terminal, apply: () => apply(text, version) };
                pending.current = request;
                setDontAsk(false);
                setConfirmation(request);
            } else {
                apply(text, version);
            }
        };
        const paste = (event: ClipboardEvent) => {
            if (!event.clipboardData) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            requestPaste(event.clipboardData.getData("text/plain"));
        };
        const startSelection = (event: MouseEvent) => { selecting = event.button === 0; };
        const finishSelection = (event: MouseEvent) => {
            if (!selecting || event.button !== 0 || closed) return;
            selecting = false;
            const text = terminal.getSelection();
            if (!text) return;
            void copyMessageText(text).then((result) => {
                if (!closed) setError(result.copied ? null : "자동 복사하지 못했어요. 선택한 내용을 Ctrl+C / ⌘C로 복사해 주세요.");
            });
        };
        const contextMenu = (event: MouseEvent) => {
            event.preventDefault();
            if (event.shiftKey || !writable()) return;
            event.stopImmediatePropagation();
            if (reading || pending.current || !terminalAction(() => {}, onBlocked)) return;
            setError(null);
            if (!navigator.clipboard?.readText) {
                setError("우클릭 붙여넣기를 사용할 수 없어요. Ctrl+V / ⌘V로 붙여넣어 주세요.");
                return;
            }
            reading = true;
            const version = activity.current.version;
            void navigator.clipboard.readText().then((text) => {
                requestPaste(text, version);
            }, () => {
                if (writable(version)) setError("클립보드를 읽지 못했어요. 브라우저 권한을 확인하거나 Ctrl+V / ⌘V로 붙여넣어 주세요.");
            }).finally(() => { reading = false; });
        };
        host.addEventListener("paste", paste, true);
        host.addEventListener("mousedown", startSelection);
        host.addEventListener("contextmenu", contextMenu, true);
        document.addEventListener("mouseup", finishSelection);
        return () => {
            closed = true;
            host.removeEventListener("paste", paste, true);
            host.removeEventListener("mousedown", startSelection);
            host.removeEventListener("contextmenu", contextMenu, true);
            document.removeEventListener("mouseup", finishSelection);
            if (pending.current?.terminal === terminal) dismiss();
        };
    }, [dismiss, onBlocked]);

    const approve = () => {
        const request = pending.current;
        if (!request) return;
        if (dontAsk) {
            try {
                savePrefs({ ...loadPrefs(), confirmTerminalPaste: false });
            } catch {
                setError("이 기기에 선택을 저장하지 못했어요. 체크를 해제하고 다시 붙여넣어 주세요.");
                return;
            }
        }
        dismiss();
        request.apply();
    };
    const clipboardUI = <>
        {error && !confirmation && <Text as="p" display="block" type="supporting" color="error" role="alert">{error}</Text>}
        {confirmation && <CreationDialog label="여러 줄 붙여넣기" onClose={dismiss} width="28em" footer={<>
            <CheckboxInput label="다시 묻지 않기" value={dontAsk} onChange={setDontAsk} />
            <Stack direction="horizontal" justify="end" gap={2}>
                <Button type="button" variant="secondary" onClick={dismiss}>취소</Button>
                <ServerActionButton type="button" onClick={approve}>붙여넣기</ServerActionButton>
            </Stack>
        </>}>
            <Heading level={2}>여러 줄을 붙여넣을까요?</Heading>
            <Text as="p" display="block" type="supporting" color="warning">명령이 바로 실행될 수 있어요.</Text>
            {error && <Text as="p" display="block" type="supporting" color="error" role="alert">{error}</Text>}
        </CreationDialog>}
    </>;
    return { bindClipboard, clipboardUI };
}
