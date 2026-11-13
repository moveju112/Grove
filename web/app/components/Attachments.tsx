import { useEffect, useRef, useState } from "react";
import { ApiError, api, authGeneration, newKey, rawGet } from "../api/client";
import { parseDraftAttachments, type DraftAttachment as Attachment } from "../state/drafts";
import { attachmentIssue } from "./capabilities/browser";

export type { DraftAttachment as Attachment } from "../state/drafts";
type Pending = { key: string; file?: File; attachment?: Attachment; error?: string };
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;

// 원문·토큰은 localStorage에 넣지 않고, 업로드 완료한 ID와 표시 metadata만 초안 사본별로 보존한다.
export function useAttachments(draftKey: string, projectId: string, initial?: Attachment[]) {
    const key = `${draftKey}:attachments`;
    const [owner] = useState(authGeneration);
    const entries = (saved: unknown): Pending[] => parseDraftAttachments(saved).filter((a) => a.project_id === projectId).map((a) => ({ key: newKey(), attachment: a }));
    const [items, setItems] = useState<Pending[]>(() => {
        try {
            return entries(initial ?? JSON.parse(localStorage.getItem(key) ?? "[]"));
        } catch { return []; }
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const current = useRef(items);
    const lock = useRef(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const replace = (next: Pending[]) => {
        if (authGeneration() !== owner) return;
        current.current = next;
        if (alive.current) setItems(next);
        // 완료 응답이 화면 이동 뒤 도착해도 같은 초안에서 원문을 다시 찾는다.
        try { localStorage.setItem(key, JSON.stringify(next.flatMap((i) => i.attachment ? [i.attachment] : []))); } catch { /* 저장 공간이 없으면 현재 입력은 유지한다. */ }
    };
    const upload = async (entry: Pending): Promise<Pending> => {
        try {
            const data = new Uint8Array(await entry.file!.arrayBuffer());
            let binary = "";
            for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
            const attachment = await api.post<Attachment>(`/projects/${projectId}/attachments`, { name: entry.file!.name, data_base64: btoa(binary) }, { key: entry.key });
            return { key: entry.key, attachment };
        } catch (e) {
            return { ...entry, error: e instanceof ApiError ? e.message : "업로드 응답을 받지 못했습니다. 같은 요청으로 다시 시도하세요" };
        }
    };
    const process = async (entries: Pending[]) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            for (const entry of entries) {
                const result = await upload(entry);
                replace(current.current.map((i) => i.key === entry.key ? result : i));
            }
        } finally { lock.current = false; if (alive.current) setBusy(false); }
    };
    const add = async (files: File[]) => {
        if (lock.current || !projectId || files.length === 0) return;
        setError(null);
        if (current.current.length + files.length > 8 || files.some((f) => f.size > MAX_FILE) || current.current.reduce((n, i) => n + (i.attachment?.size ?? i.file?.size ?? 0), 0) + files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) {
            setError("첨부는 최대 8개, 파일당 4MiB, 전체 8MiB까지 선택할 수 있습니다");
            return;
        }
        const added = files.map((file) => ({ key: newKey(), file }));
        replace([...current.current, ...added]);
        await process(added);
    };
    const remove = (key: string) => {
        if (lock.current) return;
        // 서버의 미참조 원문은 유예 후 GC가 정리한다. 불명 전송 직후 이미 연결된 원문도 안전하다.
        replace(current.current.filter((i) => i.key !== key));
    };
    return { items, busy, error, add, remove, retry: (i: Pending) => process([i]),
        restore: (saved: Attachment[]) => replace(entries(saved)),
        clearSent: (ids: string[]) => replace(current.current.filter((i) => !i.attachment || !ids.includes(i.attachment.id))),
        ids: items.flatMap((i) => i.attachment ? [i.attachment.id] : []), ready: items.every((i) => !!i.attachment) };
}

export function AttachmentPicker({ draft, disabled }: { draft: ReturnType<typeof useAttachments>; disabled: boolean }) {
    const input = useRef<HTMLInputElement>(null);
    const [supportError, setSupportError] = useState<string | null>(null);
    return <div className="attachment-picker">
        <input ref={input} type="file" multiple aria-label="첨부파일 선택" hidden disabled={disabled || draft.busy} onChange={(e) => { void draft.add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button className="ghost small" disabled={disabled || draft.busy} onClick={() => {
            const issue = attachmentIssue();
            setSupportError(issue);
            if (!issue) {
                try { input.current?.click(); }
                catch { setSupportError("파일 선택 창을 열지 못했습니다. 브라우저 설정을 확인하거나 파일 내용을 메시지에 붙여 넣으세요."); }
            }
        }}>파일 첨부</button>
        {supportError && <div className="warn small" role="status">{supportError}</div>}
        <span className="muted small">파일당 4MiB · 전체 8MiB · 최대 8개</span>
        <div className="muted small">드래그가 안 되면 파일 첨부 버튼을 사용하세요. 일반 첨부에는 파일 시스템 접근 API가 필요하지 않습니다.</div>
        <div className="muted small">첨부 선택 목록은 이 기기에 저장됩니다. 미전송 파일은 24시간 뒤 만료됩니다.</div>
        {draft.error && <div role="alert">{draft.error}</div>}
        <ul className="attachment-list" aria-label="선택한 첨부파일">
            {draft.items.map((i) => <li key={i.key}>
                {i.attachment ? <AttachmentCard attachment={i.attachment} /> : <span>{i.file?.name} · {draft.busy && !i.error ? "업로드 중…" : "업로드되지 않음"}</span>}
                {i.error && <><span role="alert">{i.error}</span><button disabled={disabled || draft.busy} onClick={() => void draft.retry(i)}>업로드 다시 시도</button></>}
                <button className="ghost small" aria-label={`${i.attachment?.name ?? i.file?.name} 첨부 제거`} disabled={disabled || draft.busy} onClick={() => draft.remove(i.key)}>제거</button>
            </li>)}
        </ul>
    </div>;
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
    return <ul className="attachment-list" aria-label="메시지 첨부파일">{attachments.map((a) => <li key={a.id}><AttachmentCard attachment={a} /></li>)}</ul>;
}

function AttachmentCard({ attachment: a }: { attachment: Attachment }) {
    const [preview, setPreview] = useState<{ url?: string; text?: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const alive = useRef(true);
    const urls = useRef<{ preview?: string; download?: string }>({});
    const closePreview = () => {
        if (urls.current.preview) URL.revokeObjectURL(urls.current.preview);
        delete urls.current.preview;
        setPreview(null);
    };
    useEffect(() => { alive.current = true; return () => {
        alive.current = false;
        Object.values(urls.current).forEach((u) => URL.revokeObjectURL(u));
    }; }, []);
    const read = async (download: boolean) => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError(null);
        try {
            const data = await rawGet(`/attachments/${a.id}/content`);
            if (!alive.current) return;
            if (download) {
                const url = URL.createObjectURL(new Blob([data], { type: a.mime }));
                if (urls.current.download) URL.revokeObjectURL(urls.current.download);
                urls.current.download = url;
                const link = document.createElement("a"); link.href = url; link.download = a.name; link.click();
            } else if (a.mime === "text/plain") setPreview({ text: new TextDecoder().decode(data).slice(0, 8192) });
            else {
                const url = URL.createObjectURL(new Blob([data], { type: a.mime }));
                urls.current.preview = url; setPreview({ url });
            }
        } catch (e) { if (alive.current) setError(e instanceof ApiError ? e.message : "첨부파일을 읽지 못했습니다"); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    };
    const canPreview = ["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"].includes(a.mime);
    return <div className="attachment-card" data-testid="attachment-card">
        <span>{a.name} · {(a.size / 1024).toFixed(1)}KiB{a.image ? ` · ${a.image.width}×${a.image.height}` : ""}</span>
        {a.image && <span className="muted small">모델 입력 {a.image.model_width}×{a.image.model_height} · 첫 프레임</span>}
        {a.mime === "text/plain" && <span className="muted small">모델에는 앞 8192자까지 보냅니다</span>}
        {!a.mime.startsWith("image/") && a.mime !== "text/plain" && <span className="muted small">모델에는 파일명·크기 등 정보만 보냅니다</span>}
        {!a.stored && <span role="alert">원문이 누락되었습니다</span>}
        <div>
            {canPreview && <button className="ghost small" disabled={busy || !a.stored} onClick={() => preview ? closePreview() : void read(false)}>{preview ? "미리보기 닫기" : "미리보기"}</button>}
            <button className="ghost small" disabled={busy || !a.stored} onClick={() => void read(true)}>원문 다운로드</button>
        </div>
        {error && <div role="alert">{error}</div>}
        {preview?.url && <img className="attachment-preview" src={preview.url} alt={a.name} />}
        {preview?.text !== undefined && <pre className="attachment-text">{preview.text}{a.size > 8192 ? "\n(앞부분만 표시)" : ""}</pre>}
    </div>;
}
