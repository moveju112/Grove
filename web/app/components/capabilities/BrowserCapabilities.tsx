import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from "@astryxdesign/core/Table";
import { Button as GroveButton } from "../../design/Button";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
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
    return <GroveStack gap={0} data-testid="browser-capabilities">
        <GroveText as="p" display="block" type="inherit" color="inherit">보안 컨텍스트: <strong>{snapshot.secureContext ? "예" : "아니요"}</strong></GroveText>
        {!snapshot.secureContext && <GroveText as="p" display="block" type="supporting" color="warning">알림·Clipboard·파일 시스템 접근에는 HTTPS 또는 localhost가 필요합니다.</GroveText>}
        <ScrollableArea axis="inline" label="이 기기의 브라우저 기능 표" maxWidth="100%"><Table density="compact">
            <caption>이 기기의 브라우저 기능</caption>
            <TableHeader><TableRow isHeaderRow><TableHeaderCell scope="col">기능</TableHeaderCell><TableHeaderCell scope="col">API 지원</TableHeaderCell><TableHeaderCell scope="col">권한</TableHeaderCell><TableHeaderCell scope="col">조건·대안</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{snapshot.items.map((item) => <TableRow key={item.id} data-testid={`browser-capability-${item.id}`}>
                <TableHeaderCell scope="row">{item.label}</TableHeaderCell>
                <TableCell>{item.supported ? "지원" : item.secureRequired && !snapshot.secureContext ? "미노출·보안 컨텍스트에서 재확인" : "미지원"}</TableCell>
                <TableCell>{item.supported ? PERMISSION_LABEL[item.permission] : item.secureRequired && !snapshot.secureContext ? "보안 컨텍스트에서 재확인" : "해당 없음"}</TableCell>
                <TableCell>{capabilityIssue(snapshot, item) ?? <>
                    {item.secureRequired ? "보안 컨텍스트 필요. " : "보안 컨텍스트 불필요. "}
                    {item.permission === "unknown" && "권한을 조회할 수 없어 미확인입니다. 거부를 뜻하지 않습니다. "}
                    {item.permission === "per-use" && "선택 전에는 개별 파일·폴더 권한을 조회하지 않습니다. "}
                    {item.alternative}
                </>}</TableCell>
            </TableRow>)}</TableBody>
        </Table></ScrollableArea>
    </GroveStack>;
}

export function BrowserCapabilitiesSettings() {
    const [snapshot, refresh] = useBrowserCapabilities();
    return <>
        {snapshot ? <BrowserCapabilitiesPanel snapshot={snapshot} /> : <GroveText as="p" display="block" type="inherit" color="inherit" role="status">브라우저 기능 확인 중…</GroveText>}
        <GroveButton variant="secondary" density="compact" onClick={refresh}>브라우저 기능 새로 확인</GroveButton>
    </>;
}

export function currentNotificationIssue(snapshot: BrowserCapabilities | null): string | null {
    const value = snapshot ?? detectBrowserCapabilities();
    return capabilityIssue(value, value.items.find((item) => item.id === "notifications")!);
}
