import { Text as GroveText } from "@astryxdesign/core/Text";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
import { ApiError, api } from "../api/client";
import { useCapability } from "../state/capabilities";

type Capture = {
    terminal_id: string; lines: string[]; total_lines: number; start: number; end: number; rows: number; cols: number;
    source: "live" | "saved" | "legacy_output"; status: string;
};

export function TerminalCapture({ terminalId, enabled }: { terminalId: string; enabled: boolean }) {
    const supported = useCapability("terminal_capture_v1");
    const [range, setRange] = useState({ start: "", end: "" });
    const [capture, setCapture] = useState<Capture | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => request.current?.abort(), [terminalId]);
    useEffect(() => {
        if (!capture) { setUrl(null); return; }
        const next = URL.createObjectURL(new Blob([capture.lines.join("\n")], { type: "text/plain;charset=utf-8" }));
        setUrl(next);
        return () => URL.revokeObjectURL(next);
    }, [capture]);
    const read = async () => {
        if (request.current) return;
        const query = new URLSearchParams();
        for (const key of ["start", "end"] as const) {
            if (!range[key].trim()) continue;
            const value = Number(range[key]);
            if (!Number.isSafeInteger(value)) { setError("줄 번호는 안전한 범위의 정수여야 합니다."); return; }
            query.set(key, String(value));
        }
        const controller = new AbortController();
        request.current = controller;
        setBusy(true); setError(null);
        try {
            const result = await api.get<Capture>(`/terminals/${terminalId}/capture?${query}`, { signal: controller.signal });
            if (!controller.signal.aborted) setCapture(result);
        } catch (error) {
            if (!controller.signal.aborted) setError(error instanceof ApiError ? error.message : "터미널 화면을 읽지 못했습니다.");
        } finally {
            if (!controller.signal.aborted) { setBusy(false); request.current = null; }
        }
    };
    if (supported === false) return null;
    return <DetailDialog className="terminal-capture" data-testid="terminal-capture" label="화면 텍스트 캡처" title="화면 텍스트 캡처">
        <GroveText as="p" display="block" type="supporting" color="warning">최근 최대 1024줄입니다. 비밀정보가 포함될 수 있으니 다운로드 전에 확인하세요.</GroveText>
        <form className="inline wrap small" onSubmit={(event) => { event.preventDefault(); void read(); }}>
            <label>시작 줄<input aria-label="캡처 시작 줄" type="number" step="1" placeholder="처음" value={range.start} onChange={(event) => setRange({ ...range, start: event.target.value })} /></label>
            <label>끝 줄<input aria-label="캡처 끝 줄" type="number" step="1" placeholder="마지막" value={range.end} onChange={(event) => setRange({ ...range, end: event.target.value })} /></label>
            <GroveButton disabled={busy || !enabled}>지금 캡처</GroveButton>
        </form>
        <GroveText as="p" display="block" type="supporting" color="secondary">줄 번호는 0부터, 끝 줄을 포함합니다. 음수는 뒤에서 셉니다(-1은 마지막 줄). 화면에서 접힌 줄은 각각 한 줄입니다.</GroveText>
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {capture && <div data-testid="terminal-capture-result">
            <GroveText as="p" display="block" type="supporting" color="secondary">{capture.source === "live" ? "실행 화면 사본" : capture.source === "saved" ? "보존된 화면 사본" : "이전 형식의 제한된 출력에서 복원한 사본"} · {capture.cols}×{capture.rows} · 전체 {capture.total_lines}줄 중 {capture.lines.length}줄 · 자동 갱신 안 함</GroveText>
            <pre data-testid="terminal-capture-text">{capture.lines.join("\n") || "(선택한 범위에 줄이 없습니다)"}</pre>
            <div className="inline small">
                {url && <Link type="inherit" href={url} download={`terminal-${terminalId}.txt`}>캡처 텍스트 다운로드</Link>}
                <GroveButton className="ghost" onClick={() => setCapture(null)}>캡처 닫기</GroveButton>
            </div>
        </div>}
    </DetailDialog>;
}
