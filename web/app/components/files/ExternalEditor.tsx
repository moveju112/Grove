import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Select } from "../../design/Select";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useRef, useState } from "react";
import { ApiError, newKey } from "../../api/client";
import { listExternalEditors, openExternalEditor, type ExternalEditorListing } from "../../api/externalEditor";
import { useCapability } from "../../state/capabilities";
import { HelpTip } from "../HelpTip";

export type ExternalEditorControlsProps = {
    listing: ExternalEditorListing;
    selected: string;
    disabled: boolean;
    blockedReason?: string | null;
    busy: boolean;
    onSelect: (id: string) => void;
    onOpen: () => void;
};

export function ExternalEditorControls({ listing, selected, disabled, blockedReason, busy, onSelect, onOpen }: ExternalEditorControlsProps) {
    if (!listing.available) return <GroveText as="p" display="block" type="supporting" color="secondary">{listing.reason}</GroveText>;
    return <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
        <Select label="외부 편집기" hideLabel value={selected} disabled={busy} onChange={onSelect}
            options={listing.editors.map((editor) => ({ value: editor.id, label: editor.name }))} />
        <GroveButton variant="secondary" density="compact" disabled={disabled || !!blockedReason || busy || !listing.editors.some((e) => e.id === selected)}
            title={blockedReason ?? undefined} aria-description={blockedReason ?? undefined} onClick={onOpen}>
            {busy ? "여는 중…" : "외부 편집기로 열기"}
        </GroveButton>
        <HelpTip label="외부 편집기 도움말">서버 PC의 저장된 파일을 열며 저장 전 편집은 전달하지 않습니다.</HelpTip>
    </GroveStack>;
}

export function ExternalEditor({ projectId, path, disabled = false, blockedReason }: { projectId: string; path: string; disabled?: boolean; blockedReason?: string | null }) {
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
    return <GroveStack gap={0} data-testid="external-editor">
        {listing && <ExternalEditorControls listing={listing} selected={selected} disabled={disabled} blockedReason={blockedReason} busy={busy}
            onSelect={(id) => { setSelected(id); setError(null); setStatus(null); }} onOpen={() => void open()} />}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {status && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">{status}</GroveText>}
    </GroveStack>;
}
