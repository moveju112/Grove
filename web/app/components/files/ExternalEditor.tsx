import { useEffect, useRef, useState } from "react";
import { ApiError, newKey } from "../../api/client";
import { listExternalEditors, openExternalEditor, type ExternalEditorListing } from "../../api/externalEditor";
import { useCapability } from "../../state/capabilities";

export type ExternalEditorControlsProps = {
    listing: ExternalEditorListing;
    selected: string;
    disabled: boolean;
    busy: boolean;
    onSelect: (id: string) => void;
    onOpen: () => void;
};

export function ExternalEditorControls({ listing, selected, disabled, busy, onSelect, onOpen }: ExternalEditorControlsProps) {
    if (!listing.available) return <p className="muted small">{listing.reason}</p>;
    return <div className="inline wrap">
        <select aria-label="외부 편집기" value={selected} disabled={busy} onChange={(e) => onSelect(e.target.value)}>
            {listing.editors.map((editor) => <option key={editor.id} value={editor.id}>{editor.name}</option>)}
        </select>
        <button className="ghost small" disabled={disabled || busy || !listing.editors.some((e) => e.id === selected)} onClick={onOpen}>
            {busy ? "여는 중…" : "외부 편집기로 열기"}
        </button>
        <span className="muted small">서버 PC의 저장된 파일을 엽니다. 저장하지 않은 편집은 전달하지 않습니다.</span>
    </div>;
}

export function ExternalEditor({ projectId, path, disabled = false }: { projectId: string; path: string; disabled?: boolean }) {
    const capability = useCapability("external_editor_v1");
    const [listing, setListing] = useState<ExternalEditorListing | null>(null);
    const [selected, setSelected] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const active = useRef(false);
    const attempt = useRef<{ path: string; editor: string; key: string } | null>(null);
    useEffect(() => {
        if (capability !== true) return;
        const controller = new AbortController();
        void listExternalEditors(controller.signal).then((value) => {
            if (controller.signal.aborted) return;
            setListing(value);
            setSelected(value.editors[0]?.id ?? "");
        }, (e: unknown) => {
            if (!controller.signal.aborted) setError(e instanceof ApiError ? e.message : "편집기 목록을 확인하지 못했습니다.");
        });
        return () => controller.abort();
    }, [capability]);
    if (capability !== true) return null;
    const open = async () => {
        if (active.current || disabled) return;
        active.current = true;
        setBusy(true);
        setError(null);
        setStatus(null);
        const prior = attempt.current;
        const request = prior?.path === path && prior.editor === selected ? prior : { path, editor: selected, key: newKey() };
        attempt.current = request;
        try {
            await openExternalEditor(projectId, request.editor, request.path, request.key);
            attempt.current = null;
            setStatus("편집기 실행을 요청했습니다. 서버 PC에서 확인하세요.");
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "응답을 받지 못했습니다. 서버 PC에서 실행 여부를 확인하세요.");
            if (e instanceof ApiError && e.status > 0 && e.status < 500 && !e.retryable && e.code !== "result_unknown") attempt.current = null;
        } finally {
            active.current = false;
            setBusy(false);
        }
    };
    return <div data-testid="external-editor">
        {listing && <ExternalEditorControls listing={listing} selected={selected} disabled={disabled} busy={busy}
            onSelect={(id) => { setSelected(id); setError(null); setStatus(null); }} onOpen={() => void open()} />}
        {error && <p className="err" role="alert">{error}</p>}
        {status && <p className="muted small" role="status">{status}</p>}
    </div>;
}
