import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
import { BooleanSelect } from "./BooleanSelect";
import { ApiError, api, PROTOCOL } from "../api/client";
import { useCapability } from "../state/capabilities";
import { useLive } from "../state/store";

export function DiagnosticsBundle() {
    const supported = useCapability("diagnostics_bundle_v1");
    const connection = useLive((live) => live.status);
    const [preparing, setPreparing] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [bundle, setBundle] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => request.current?.abort(), []);
    useEffect(() => {
        if (!bundle) { setUrl(null); return; }
        const next = URL.createObjectURL(new Blob([bundle], { type: "application/json;charset=utf-8" }));
        setUrl(next);
        return () => URL.revokeObjectURL(next);
    }, [bundle]);

    const create = async () => {
        if (!confirmed || request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true); setError(null);
        try {
            const server = await api.post<Record<string, unknown>>("/admin/diagnostics", { confirmed: true }, {
                signal: controller.signal, requires: ["diagnostics_bundle_v1"],
            });
            if (!controller.signal.aborted) {
                setBundle(JSON.stringify({ ...server, client: { protocol: PROTOCOL, connection } }, null, 2));
                setPreparing(false); setConfirmed(false);
            }
        } catch (e) {
            if (!controller.signal.aborted) setError(e instanceof ApiError ? e.message : "진단 묶음을 만들지 못했습니다.");
        } finally {
            if (!controller.signal.aborted) { setBusy(false); request.current = null; }
        }
    };

    if (supported === false) return null;
    return <GroveStack gap={0} data-testid="diagnostics-bundle">
        <GroveText type="supporting" color="secondary">소유자 전용</GroveText>
        {!preparing && <GroveButton type="button" variant="secondary" density="compact" onClick={() => { setPreparing(true); setError(null); }}>진단 묶음 준비</GroveButton>}
        {preparing && <GroveStack gap={0} role="group" aria-label="진단 정보 범위 확인">
            <GroveText as="p" display="block" type="supporting" color="inherit">포함: 버전·OS·프로토콜·DB 크기·메모리·실행/대기 수·상태별 개수·이벤트 연결 상태.</GroveText>
            <GroveText as="p" display="block" type="supporting" color="inherit">제외: 토큰·키·대화·파일·식별 정보·설정·환경 변수·로그 원문</GroveText>
            <GroveText as="p" display="block" type="supporting" color="warning">공유 전 개수·자원 사용량을 확인하세요.</GroveText>
            <BooleanSelect label="정보 범위를 확인했습니다" value={confirmed} disabled={busy} onChange={setConfirmed} trueLabel="확인함" falseLabel="확인 안 함" />
            <GroveButton type="button" disabled={!confirmed || busy} onClick={() => void create()}>진단 묶음 생성</GroveButton>
            <GroveButton type="button" variant="secondary" disabled={busy} onClick={() => { setPreparing(false); setConfirmed(false); setError(null); }}>취소</GroveButton>
        </GroveStack>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {bundle && <GroveStack gap={0}>
            <DetailDialog label="진단 묶음 미리 보기" title="공유 전 진단 묶음 미리 보기"><pre data-testid="diagnostics-preview">{bundle}</pre></DetailDialog>
            {url && <Link type="inherit" href={url} download="grove-diagnostics.json">진단 묶음 다운로드</Link>}
            <GroveButton type="button" variant="secondary" density="compact" onClick={() => setBundle(null)}>진단 묶음 지우기</GroveButton>
        </GroveStack>}
    </GroveStack>;
}
