import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Popover } from "@astryxdesign/core/Popover";
import { FileInput } from "../design/Fields";
import { List, ListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { contentStyles } from "../design/content.stylex";
import { ImagePreviewDialog, type PreviewSource } from "./ImagePreviewDialog";
import * as stylex from "@stylexjs/stylex";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { attachmentStyles } from "./attachments.stylex";
import { Icon } from "./icons";
import { ActionMenu } from "./ui/Controls";
import { ApiError, api, authGeneration, isTransportError, newKey, rawGet } from "../api/client";
import { parseAttachments, type Attachment } from "../state/sendRecovery";
import { attachmentIssue } from "./capabilities/browser";
import { useLive } from "../state/store";
import { useComposerMemory } from "../state/useComposerMemory";
import { fileUrl, rememberSentFile, sentFile, type DraftFile } from "../state/outgoing";

export type { Attachment } from "../state/sendRecovery";
type Pending = DraftFile;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_PARALLEL_UPLOADS = 3;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// 미전송 첨부는 화면 메모리에만 둔다. 올리는 동안에도 더 고르거나 뺄 수 있다.
export function useAttachments(projectId: string, resourceKey: string, copyId: string, initial?: Attachment[]) {
    const [owner] = useState(authGeneration);
    const entries = (saved: unknown): Pending[] => parseAttachments(saved).filter((a) => a.project_id === projectId).map((a) => ({ key: newKey(), attachment: a }));
    const [items, setItems] = useComposerMemory<Pending[]>(resourceKey, copyId, "attachments", () => entries(initial));
    const [error, setError] = useComposerMemory<string | null>(resourceKey, copyId, "attachmentError", () => null);
    // 진행 중인 업로드는 영역을 옮겨 다시 그린 입력창이 그대로 이어받는다.
    const [uploads] = useComposerMemory(resourceKey, copyId, "uploads", () => ({ flights: new Map<string, Promise<Pending>>(), running: 0, waiting: [] as (() => void)[] }));
    const current = useRef(items);
    current.current = items;
    const update = (change: (items: Pending[]) => Pending[]) => {
        if (authGeneration() !== owner) return;
        setItems(change);
    };
    const upload = async (entry: Pending): Promise<Pending> => {
        try {
            const data = new Uint8Array(await entry.file!.arrayBuffer());
            let binary = "";
            for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
            const attachment = await api.post<Attachment>(`/projects/${projectId}/attachments`, { name: entry.file!.name, data_base64: btoa(binary) }, { key: entry.key });
            if (authGeneration() === owner && IMAGE_MIMES.includes(attachment.mime)) rememberSentFile(attachment.id, entry.file!);
            return { key: entry.key, file: entry.file, attachment };
        } catch (e) {
            return { ...entry, error: e instanceof ApiError ? e.message : "업로드 응답을 받지 못했습니다. 같은 요청으로 다시 시도하세요" };
        }
    };
    const start = (entry: Pending): Promise<Pending> => {
        const flight = (async () => {
            // 한꺼번에 많이 골라도 동시에 올리는 수를 제한한다. 끝난 자리는 기다리던 업로드가 바로 이어받는다.
            if (uploads.running >= MAX_PARALLEL_UPLOADS) await new Promise<void>((resume) => uploads.waiting.push(resume));
            else uploads.running++;
            try { return await upload(entry); }
            finally {
                const next = uploads.waiting.shift();
                if (next) next();
                else uploads.running--;
            }
        })().then((result) => {
            // 그사이 뺀 첨부나 이미 보낸 첨부는 목록에 없으므로 되살리지 않는다.
            if (uploads.flights.get(entry.key) === flight) update((list) => list.map((i) => i.key === entry.key ? result : i));
            return result;
        });
        uploads.flights.set(entry.key, flight);
        return flight;
    };
    const add = async (files: File[]) => {
        if (!projectId || files.length === 0) return;
        setError(null);
        if (current.current.length + files.length > 8 || files.some((f) => f.size > MAX_FILE) || current.current.reduce((n, i) => n + (i.attachment?.size ?? i.file?.size ?? 0), 0) + files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) {
            setError("첨부는 최대 8개, 파일당 32MiB, 전체 128MiB까지 선택할 수 있습니다");
            return;
        }
        const added = files.map((file) => ({ key: newKey(), file }));
        current.current = [...current.current, ...added];
        update((list) => [...list, ...added]);
        await Promise.all(added.map(start));
    };
    const remove = (key: string) => {
        // 서버의 미참조 원문은 유예 후 GC가 정리한다. 불명 전송 직후 이미 연결된 원문도 안전하다.
        uploads.flights.delete(key);
        update((list) => list.filter((i) => i.key !== key));
    };
    /// 보내기: 지금 목록을 입력창에서 비우고 넘긴다. settled는 올리는 중이던 첨부까지 끝난 결과다.
    const take = () => {
        const taken = current.current;
        const keys = new Set(taken.map((i) => i.key));
        const settled = Promise.all(taken.map((i) => uploads.flights.get(i.key) ?? i));
        for (const key of keys) uploads.flights.delete(key);
        current.current = [];
        update((list) => list.filter((i) => !keys.has(i.key)));
        return { items: taken, settled };
    };
    /// 보내지 못한 첨부를 그사이 새로 고른 첨부 앞에 돌려놓는다.
    const restore = (files: Pending[]) => update((list) => [...files.filter((file) => !list.some((i) => i.key === file.key)), ...list]);
    const retry = (i: Pending) => {
        const entry = { key: i.key, file: i.file };
        update((list) => list.map((item) => item.key === i.key ? entry : item));
        return start(entry);
    };
    return { items, error, add, remove, retry, take, restore,
        /// busy: 아직 올리는 중인 첨부가 있다. failed: 올리지 못한 첨부가 있어 빼거나 다시 올려야 한다.
        busy: items.some((i) => !i.attachment && !i.error), failed: items.some((i) => !!i.error),
        clearSent: (ids: string[]) => update((list) => list.filter((i) => !i.attachment || !ids.includes(i.attachment.id))),
        ids: items.flatMap((i) => i.attachment ? [i.attachment.id] : []), ready: items.every((i) => !!i.attachment) };
}

export function AttachmentPicker({ draft, disabled, onIssue }: { draft: ReturnType<typeof useAttachments>; disabled: boolean; onIssue: (issue: string | null) => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [reading, setReading] = useState(false);
    const latest = useRef<{ blocked: boolean; add: typeof draft.add; onIssue: typeof onIssue } | null>(null);
    useLayoutEffect(() => {
        latest.current = { blocked: disabled, add: draft.add, onIssue };
        return () => { latest.current = null; };
    });
    const canReadImage = /Android/.test(navigator.userAgent) && window.isSecureContext && typeof navigator.clipboard?.read === "function";
    const blocked = disabled || reading;
    const pickFile = () => {
        setOpen(false);
        const issue = attachmentIssue();
        onIssue(issue);
        if (!issue) {
            try { input.current?.click(); }
            catch { onIssue("파일 선택 창을 열지 못했습니다. 브라우저 설정을 확인하거나 파일 내용을 메시지에 붙여 넣으세요."); }
        }
    };
    const pasteImage = async () => {
        if (blocked || !canReadImage) return;
        setOpen(false);
        onIssue(null);
        setReading(true);
        const owner = authGeneration();
        try {
            // 버튼을 누를 때만 읽고, 텍스트나 HTML은 꺼내지 않는다.
            const items = await navigator.clipboard.read();
            const item = items.find((entry) => entry.types.some((type) => IMAGE_MIMES.includes(type)));
            const mime = item?.types.find((type) => IMAGE_MIMES.includes(type));
            const image = item && mime ? await item.getType(mime) : null;
            const current = latest.current;
            if (!current || current.blocked || authGeneration() !== owner) return;
            if (image?.size && mime) {
                const ext = mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
                void current.add([new File([image], `clipboard.${ext}`, { type: mime })]);
            } else {
                const formats = [...new Set(items.flatMap((entry) => entry.types))].join(", ") || "없음";
                current.onIssue(`붙여넣을 사진을 찾지 못했습니다 (항목 ${items.length}개 · 형식 ${formats}). 사진을 복사하거나 파일에서 선택하세요.`);
            }
        } catch {
            if (authGeneration() === owner) latest.current?.onIssue("클립보드 사진을 읽지 못했습니다. 브라우저 권한을 확인하거나 파일에서 선택하세요.");
        } finally {
            if (latest.current) setReading(false);
        }
    };
    const trigger = <GroveButton type="button" variant="secondary" appearance="icon" aria-label="파일 첨부" title="파일 첨부 · 최대 8개, 파일당 32MiB, 전체 128MiB · 미전송 파일은 24시간 뒤 만료"
        disabled={blocked} onClick={canReadImage ? undefined : pickFile}><Icon name="attachment" /></GroveButton>;
    return <GroveStack direction="horizontal" align="center" gap={0} width={32} data-testid="attachment-picker">
        <GroveStack hidden><FileInput ref={input} isMultiple label="첨부파일 선택" isLabelHidden
            isDisabled={disabled} value={null}
            onChange={(files) => { if (files) void draft.add(Array.isArray(files) ? files : [files]); }} /></GroveStack>
        {canReadImage ? <Popover label="첨부 방식" isOpen={open && !blocked} onOpenChange={setOpen} placement="above" alignment="start"
            width={208} padding={2} isModal={false} content={<GroveStack gap={1}>
                <GroveButton type="button" variant="secondary" onClick={pickFile}>파일 선택</GroveButton>
                <GroveButton type="button" variant="secondary" onClick={() => void pasteImage()}>클립보드 사진 붙여넣기</GroveButton>
            </GroveStack>}>{trigger}</Popover> : trigger}
    </GroveStack>;
}

export function AttachmentSelection({ draft, disabled }: { draft: ReturnType<typeof useAttachments>; disabled: boolean }) {
    if (!draft.items.length && !draft.error) return null;
    const images = draft.items.filter((i) => IMAGE_MIMES.includes(i.attachment?.mime ?? i.file?.type ?? ""));
    const files = draft.items.filter((i) => !images.includes(i));
    const remove = (i: Pending, image = false) => <GroveButton type="button" appearance="icon"
        xstyle={image && attachmentStyles.removeImage} aria-label={`${i.attachment?.name ?? i.file?.name} 첨부 제거`}
        disabled={disabled} onClick={() => draft.remove(i.key)}><Icon name="close" size={14} /></GroveButton>;
    return <GroveStack gap={1} xstyle={attachmentStyles.row} data-testid="attachment-selection">
        {draft.error && <GroveText as="div" display="block" type="inherit" color="error" role="alert">{draft.error}</GroveText>}
        {!!images.length && <GroveStack direction="horizontal" gap={2} xstyle={attachmentStyles.strip} role="list" aria-label="선택한 이미지" data-swipe-blocked>
            {images.map((i) => <ImageAttachment key={i.key} name={i.attachment?.name ?? i.file!.name}
                file={i.file} attachment={i.attachment} trailing={remove(i, true)} />)}
        </GroveStack>}
        {!!files.length && <List density="compact" edge="flush" aria-label="선택한 첨부파일">
            {files.map((i) => <ListItem key={i.key} label={i.attachment
                ? <AttachmentCard attachment={i.attachment} trailing={remove(i)} />
                : <AttachmentRow name={i.file?.name ?? ""} detail={i.error ? "업로드되지 않음" : "업로드 중…"} actions={remove(i)} />} />)}
        </List>}
        {draft.items.filter((i) => i.error).map((i) => <GroveStack key={i.key} gap={1}>
            <GroveText type="supporting" color="error" role="alert">{i.attachment?.name ?? i.file?.name}: {i.error}</GroveText>
            <GroveButton type="button" disabled={disabled} onClick={() => void draft.retry(i)}>업로드 다시 시도</GroveButton>
        </GroveStack>)}
    </GroveStack>;
}

export function AttachmentList({ attachments, gallery = false }: { attachments: Attachment[]; gallery?: boolean }) {
    const images = attachments.filter((a) => IMAGE_MIMES.includes(a.mime));
    const files = attachments.filter((a) => !IMAGE_MIMES.includes(a.mime));
    return <GroveStack gap={1} xstyle={attachmentStyles.row} role="group" aria-label="메시지 첨부파일">
        {!!images.length && <GroveStack direction="horizontal" gap={2} xstyle={attachmentStyles.strip} role="list" aria-label="첨부 이미지" data-swipe-blocked>
            {gallery && images.length > 1 ? <AnswerImageGallery images={images} />
                : images.map((a) => <ImageAttachment key={a.id} name={a.name} attachment={a} />)}
        </GroveStack>}
        {!!files.length && <List density="compact" edge="flush">{files.map((a) => <ListItem key={a.id} label={<AttachmentCard attachment={a} />} />)}</List>}
    </GroveStack>;
}

/// 보내는 중인 메시지의 첨부. 올리는 중인 파일도 고른 즉시 보인다.
export function OutgoingAttachments({ files }: { files: DraftFile[] }) {
    const images = files.filter((i) => IMAGE_MIMES.includes(i.attachment?.mime ?? i.file?.type ?? ""));
    const rest = files.filter((i) => !images.includes(i));
    return <GroveStack gap={1} xstyle={attachmentStyles.row} role="group" aria-label="메시지 첨부파일">
        {!!images.length && <GroveStack direction="horizontal" gap={2} xstyle={attachmentStyles.strip} role="list" aria-label="첨부 이미지" data-swipe-blocked>
            {images.map((i) => <ImageAttachment key={i.key} name={i.attachment?.name ?? i.file!.name} file={i.file} attachment={i.attachment} />)}
        </GroveStack>}
        {!!rest.length && <List density="compact" edge="flush">{rest.map((i) => <ListItem key={i.key} label={i.attachment
            ? <AttachmentCard attachment={i.attachment} />
            : <AttachmentRow name={i.file?.name ?? ""} detail={`${((i.file?.size ?? 0) / 1024).toFixed(1)}KiB`} actions={null} />} />)}</List>}
    </GroveStack>;
}

function AnswerImageGallery({ images }: { images: Attachment[] }) {
    const [selected, select] = useState<string | null>(null);
    const [sources, setSources] = useState<Record<string, PreviewSource>>({});
    const publish = useCallback((id: string, source: PreviewSource | null) => {
        setSources((previous) => {
            const next = { ...previous };
            if (source) next[id] = source;
            else delete next[id];
            return next;
        });
    }, []);
    const index = images.findIndex((image) => image.id === selected);
    const current = images[index];
    const source = current && sources[current.id];
    return <>
        {images.map((image) => <ImageAttachment key={image.id} name={image.name} attachment={image} onSelect={select} onSource={publish} />)}
        {current && <ImagePreviewDialog name={current.name} source={source} onClose={() => select(null)}
            onDownload={source?.url ? () => saveFile(source.url!, current.name) : undefined}
            gallery={{ images, sources, index, select }} />}
    </>;
}

export function ImageAttachment({ name, file, attachment, trailing, projectFile, inline = false, onSelect, onSource }: {
    name: string; file?: File; attachment?: Attachment; trailing?: ReactNode;
    onSelect?: (id: string) => void; onSource?: (id: string, source: PreviewSource | null) => void;
    projectFile?: { projectId: string; path: string; mime: string }; inline?: boolean;
}) {
    // 방금 올린 사진은 서버에서 다시 받지 않고 고른 파일로 보인다.
    const local = file ?? (attachment ? sentFile(attachment.id) : undefined);
    const [url, setUrl] = useState<string | null>(() => local ? fileUrl(local) : null);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const connection = useLive((state) => state.status);
    const previousConnection = useRef(connection);
    useEffect(() => {
        const previous = previousConnection.current;
        previousConnection.current = connection;
        if (connection === "live" && previous !== connection && !url) setAttempt((n) => n + 1);
    }, [connection, url]);
    const id = attachment?.id;
    const stored = attachment?.stored;
    const mime = attachment?.mime ?? projectFile?.mime;
    const projectId = projectFile?.projectId;
    const path = projectFile?.path;
    useEffect(() => {
        let active = true;
        let objectUrl: string | undefined;
        setError(null);
        if (local) { setUrl(fileUrl(local)); return; }
        setUrl(null);
        const show = (blob: Blob) => {
            if (!active) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
        };
        if (stored || projectId) void rawGet(projectId
            ? `/projects/${encodeURIComponent(projectId)}/files/raw?path=${encodeURIComponent(path!)}`
            : `/attachments/${id}/content`)
            .then((data) => show(new Blob([data], { type: mime })))
            .catch((e) => { if (active && !isTransportError(e)) setError(e instanceof ApiError ? e.message : "이미지를 불러오지 못했어요."); });
        else setError("원문이 누락되었습니다");
        return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [local, id, stored, mime, projectId, path, attempt]);
    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    const retryRead = stored || projectId ? retry : undefined;
    useLayoutEffect(() => {
        if (!onSource || !id) return;
        onSource(id, { url, error, retry: retryRead });
        return () => onSource(id, null);
    }, [onSource, id, url, error, retryRead]);
    return <GroveStack as={inline ? "span" : "div"} role={inline ? undefined : "listitem"}
        xstyle={[attachmentStyles.tile, inline && attachmentStyles.inlineTile]} data-testid={projectFile ? "markdown-image" : "attachment-card"} data-image-attachment>
        <GroveButton type="button" variant="secondary" width={80} xstyle={attachmentStyles.thumbnail}
            aria-label={`${name} 미리보기`} aria-haspopup="dialog" onClick={() => onSelect && id ? onSelect(id) : setOpen(true)}>
            {url && !error ? <img {...stylex.props(attachmentStyles.image)} src={url} alt={name} onError={() => setError("이미지를 표시하지 못했어요.")} />
                : <Icon name="file" size={24} />}
        </GroveButton>
        {trailing}
        {error && <GroveText as="span" type="supporting" color="error" role="alert">{error}</GroveText>}
        {open && <ImagePreviewDialog name={name} source={{ url, error, retry: retryRead }} onClose={() => setOpen(false)}
            onDownload={attachment && url ? () => saveFile(url, name) : undefined} />}
    </GroveStack>;
}

function AttachmentRow({ name, detail, actions }: {
    name: string; detail: string; actions: ReactNode;
}) {
    return <GroveStack direction="horizontal" align="center" gap={2} xstyle={attachmentStyles.row}>
        <GroveStack xstyle={attachmentStyles.fileIcon}><Icon name="file" size={18} /></GroveStack>
        <GroveStack gap={0} xstyle={attachmentStyles.info}>
            <Tooltip content={name} hasHoverIndication={false}>
                <GroveText type="inherit" color="inherit" xstyle={attachmentStyles.name}>{name}</GroveText>
            </Tooltip>
            <GroveText type="supporting" color="secondary" xstyle={attachmentStyles.name}>{detail}</GroveText>
        </GroveStack>
        <GroveStack direction="horizontal" align="center" gap={1} xstyle={attachmentStyles.actions}>{actions}</GroveStack>
    </GroveStack>;
}

function saveFile(url: string, name: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
}

function AttachmentCard({ attachment: a, trailing }: { attachment: Attachment; trailing?: ReactNode }) {
    const hintAnchor = useRef<HTMLDivElement>(null);
    const [preview, setPreview] = useState<{ kind: "text" | "media"; value: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const alive = useRef(true);
    const downloadUrl = useRef<string | null>(null);
    const previewUrl = useRef<string | null>(null);
    const playable = a.mime.startsWith("video/") || a.mime.startsWith("audio/");
    useEffect(() => { alive.current = true; return () => {
        alive.current = false;
        if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    }; }, []);
    const closePreview = () => {
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = null;
        setPreview(null);
        setError(null);
    };
    const read = async (download: boolean) => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError(null);
        try {
            const data = await rawGet(`/attachments/${a.id}/content`);
            if (!alive.current) return;
            if (download) {
                const url = URL.createObjectURL(new Blob([data], { type: a.mime }));
                if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
                downloadUrl.current = url;
                saveFile(url, a.name);
            } else if (playable) {
                const url = URL.createObjectURL(new Blob([data], { type: a.mime }));
                previewUrl.current = url;
                setPreview({ kind: "media", value: url });
            } else setPreview({ kind: "text", value: new TextDecoder().decode(data).slice(0, 8192) });
        } catch (e) { if (alive.current) setError(e instanceof ApiError ? e.message : "첨부파일을 읽지 못했습니다"); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    };
    const canPreview = a.mime === "text/plain";
    const hint = canPreview ? "모델에는 앞 8192자까지 보냅니다" : "모델에는 파일명·크기 등 정보만 보냅니다";
    const playbackError = () => setError("이 브라우저에서 재생할 수 없어요. 원문을 다운로드해 열어 보세요.");
    const actions = <>
        {(canPreview || playable) && <GroveButton variant="secondary" density="compact" disabled={busy || !a.stored} onClick={() => preview ? closePreview() : void read(false)}>{preview ? "미리보기 닫기" : playable ? "재생" : "미리보기"}</GroveButton>}
        <GroveButton variant="secondary" density="compact" disabled={busy || !a.stored} onClick={() => void read(true)}>원문 다운로드</GroveButton>
    </>;
    return <><GroveStack ref={hintAnchor} gap={1} width="100%" maxWidth="100%" data-testid="attachment-card">
        <AttachmentRow name={a.name} detail={`${(a.size / 1024).toFixed(1)}KiB`}
            actions={<><ActionMenu label={`${a.name} 첨부 작업`}>{actions}</ActionMenu>{trailing}</>} />
        {!a.stored && <GroveText type="inherit" color="inherit" role="alert">원문이 누락되었습니다</GroveText>}
        {error && <GroveText as="div" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        {preview?.kind === "text" && <pre {...stylex.props(contentStyles.attachmentText)} data-testid="attachment-text">{preview.value}{a.size > 8192 ? "\n(앞부분만 표시)" : ""}</pre>}
        {preview?.kind === "media" && (a.mime.startsWith("video/")
            ? <video {...stylex.props(attachmentStyles.player)} aria-label={a.name} src={preview.value} controls playsInline preload="metadata" onError={playbackError} />
            : <audio {...stylex.props(attachmentStyles.player)} aria-label={a.name} src={preview.value} controls preload="metadata" onError={playbackError} />)}
    </GroveStack><Tooltip anchorRef={hintAnchor} content={hint} hasHoverIndication={false} touchTrigger="none" focusTrigger="never" /></>;
}
