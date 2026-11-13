import { useCallback, useEffect, useRef, useState } from "react";
import "./capabilities.css";
import {
    browserEnvironment, capabilityIssue, detectBrowserCapabilities, observeBrowserCapabilities, PERMISSION_LABEL,
    type BrowserCapabilities,
} from "./browser";

export function useBrowserCapabilities() {
    const [snapshot, setSnapshot] = useState<BrowserCapabilities | null>(null);
    const stop = useRef<(() => void) | undefined>(undefined);
    const refresh = useCallback(() => {
        stop.current?.();
        stop.current = observeBrowserCapabilities(browserEnvironment(), setSnapshot);
    }, []);
    useEffect(() => {
        refresh();
        const visible = () => { if (document.visibilityState === "visible") refresh(); };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", visible);
        return () => {
            stop.current?.();
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [refresh]);
    return [snapshot, refresh] as const;
}

export function BrowserCapabilitiesPanel({ snapshot }: { snapshot: BrowserCapabilities }) {
    return <div data-testid="browser-capabilities">
        <p>보안 컨텍스트: <strong>{snapshot.secureContext ? "예" : "아니요"}</strong></p>
        {!snapshot.secureContext && <p className="warn small">알림·Clipboard·파일 시스템 접근에는 HTTPS 또는 localhost가 필요합니다.</p>}
        <div className="browser-capabilities-table"><table>
            <caption>이 기기의 브라우저 기능</caption>
            <thead><tr><th>기능</th><th>API 지원</th><th>권한</th><th>조건·대안</th></tr></thead>
            <tbody>{snapshot.items.map((item) => <tr key={item.id} data-testid={`browser-capability-${item.id}`}>
                <th scope="row">{item.label}</th>
                <td>{item.supported ? "지원" : item.secureRequired && !snapshot.secureContext ? "미노출·보안 컨텍스트에서 재확인" : "미지원"}</td>
                <td>{item.supported ? PERMISSION_LABEL[item.permission] : item.secureRequired && !snapshot.secureContext ? "보안 컨텍스트에서 재확인" : "해당 없음"}</td>
                <td>{capabilityIssue(snapshot, item) ?? <>
                    {item.secureRequired ? "보안 컨텍스트 필요. " : "보안 컨텍스트 불필요. "}
                    {item.permission === "unknown" && "권한을 조회할 수 없어 미확인입니다. 거부를 뜻하지 않습니다. "}
                    {item.permission === "per-use" && "선택 전에는 개별 파일·폴더 권한을 조회하지 않습니다. "}
                    {item.alternative}
                </>}</td>
            </tr>)}</tbody>
        </table></div>
    </div>;
}

export function BrowserCapabilitiesSettings() {
    const [snapshot, refresh] = useBrowserCapabilities();
    return <>
        {snapshot ? <BrowserCapabilitiesPanel snapshot={snapshot} /> : <p role="status">브라우저 기능 확인 중…</p>}
        <button className="ghost small" onClick={refresh}>브라우저 기능 새로 확인</button>
    </>;
}

export function currentNotificationIssue(snapshot: BrowserCapabilities | null): string | null {
    const value = snapshot ?? detectBrowserCapabilities();
    return capabilityIssue(value, value.items.find((item) => item.id === "notifications")!);
}
