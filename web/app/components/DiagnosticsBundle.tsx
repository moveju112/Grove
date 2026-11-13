import { useEffect, useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
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
    return <div data-testid="diagnostics-bundle">
        {!preparing && <button type="button" className="ghost small" onClick={() => { setPreparing(true); setError(null); }}>진단 묶음 준비</button>}
        {preparing && <div role="group" aria-label="진단 정보 범위 확인">
            <p className="small">포함: 버전·OS·프로토콜·DB 크기·메모리·실행/대기 수·상태별 개수·이벤트 연결 상태.</p>
            <p className="small">제외: 토큰·키·대화/파일 본문·이름/ID·개인 경로·URL·설정·환경 변수·로그 원문. 개수와 자원 사용량도 공유 전에 확인하세요.</p>
            <label className="small"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />정보 범위를 확인했습니다</label>
            <button type="button" disabled={!confirmed || busy} onClick={() => void create()}>진단 묶음 생성</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { setPreparing(false); setConfirmed(false); setError(null); }}>취소</button>
        </div>}
        {error && <p className="err" role="alert">{error}</p>}
        {bundle && <div>
            <DetailDialog label="진단 묶음 미리 보기" title="공유 전 진단 묶음 미리 보기"><pre data-testid="diagnostics-preview">{bundle}</pre></DetailDialog>
            {url && <a href={url} download="grove-diagnostics.json">진단 묶음 다운로드</a>}
            <button type="button" className="ghost small" onClick={() => setBundle(null)}>진단 묶음 지우기</button>
        </div>}
    </div>;
}
