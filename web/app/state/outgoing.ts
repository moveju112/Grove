// 보내기를 누른 직후 화면에 먼저 보이는 메시지. 서버가 접수하면 실제 메시지로 바뀌고, 보내지 못하면 입력창으로 돌아간다.
// 화면 표시용 메모리 상태다. 접수 여부와 재확인은 sendRecovery가 맡는다.

import { useSyncExternalStore } from "react";
import type { Followup, Message, MessagePage, Turn } from "../api/generated";
import type { FollowKind } from "./sendOptions";
import type { Attachment } from "./sendRecovery";
import { patchData, querySnapshot } from "./store";

/// 입력창에 올린 첨부 하나. 업로드가 끝나면 attachment, 실패하면 error가 채워진다.
export type DraftFile = { key: string; file?: File; attachment?: Attachment; error?: string };
export type Outgoing = {
    key: string; resource: string; copyId: string; text: string; files: DraftFile[]; follow?: FollowKind; createdAt: string;
    /// 이 seq 뒤의 같은 글·이 목록에 없던 대기 메시지가 보이면 서버가 접수한 것이다(응답보다 이벤트가 먼저 올 때).
    afterSeq: number; knownFollowups: string[];
};

const EMPTY: Outgoing[] = [];
const byResource = new Map<string, Outgoing[]>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/// 대화는 같은 대화를 보는 모든 영역이 함께 보고, 새 대화 입력창은 그 탭만 본다.
export const outgoingResource = (resourceKey: string, copyId: string) =>
    resourceKey.startsWith("session:") ? resourceKey : `${resourceKey}#${copyId}`;

export function addOutgoing(entry: Pick<Outgoing, "key" | "resource" | "copyId" | "text" | "files" | "follow">) {
    const session = entry.resource.startsWith("session:") ? entry.resource.slice(8) : null;
    const afterSeq = session ? querySnapshot<MessagePage>(`messages:${session}`).data?.items.at(-1)?.seq ?? 0 : 0;
    const knownFollowups = session
        ? querySnapshot<{ items: { id: string }[] }>(`followups:${session}`).data?.items.map((item) => item.id) ?? [] : [];
    const rest = (byResource.get(entry.resource) ?? EMPTY).filter((item) => item.key !== entry.key);
    byResource.set(entry.resource, [...rest, { ...entry, createdAt: new Date().toISOString(), afterSeq, knownFollowups }]);
    changed();
}

export function removeOutgoing(key: string) {
    for (const [resource, items] of byResource) {
        if (!items.some((item) => item.key === key)) continue;
        const rest = items.filter((item) => item.key !== key);
        if (rest.length) byResource.set(resource, rest);
        else byResource.delete(resource);
        changed();
        return;
    }
}

export function useOutgoing(resource: string): Outgoing[] {
    return useSyncExternalStore(subscribe, () => byResource.get(resource) ?? EMPTY, () => EMPTY);
}

export const readOutgoing = (resource: string): Outgoing[] => byResource.get(resource) ?? EMPTY;

/// 서버가 접수한 글과 같은 임시 메시지는 겹쳐 보이지 않게 한다.
export function acceptedInMessages(entry: Outgoing, messages: readonly Message[]) {
    return messages.some((message) => message.role === "user" && message.seq > entry.afterSeq
        && ((message.content as { text?: string } | null)?.text ?? "") === entry.text);
}

export function acceptedInFollowups(entry: Outgoing, items: readonly { id: string; kind: string; text: string }[]) {
    return items.some((item) => !entry.knownFollowups.includes(item.id) && item.kind === entry.follow && item.text === entry.text);
}

/// 전송 응답에 담긴 메시지·실행·대기 항목을 이벤트를 기다리지 않고 조회 cache에 반영한다. 이미 있는 항목은 건드리지 않는다.
export function acceptSent(sessionId: string, sent: { message?: Message | null; turn?: Turn | null; followup?: Followup | null }) {
    const { message, turn, followup } = sent;
    if (message) patchData<MessagePage>(`messages:${sessionId}`, (page) =>
        page.items.some((item) => item.id === message.id) || (page.items.at(-1)?.seq ?? 0) >= message.seq
            ? page : { ...page, items: [...page.items, message] });
    if (turn) patchData<Turn[]>(`turns:${sessionId}`, (turns) =>
        turns.some((item) => item.id === turn.id) ? turns : [turn, ...turns].slice(0, 5));
    if (followup) patchData<{ items: Followup[] }>(`followups:${sessionId}`, (page) =>
        page.items.some((item) => item.id === followup.id) ? page : { ...page, items: [...page.items, followup] });
}

// ---- 방금 올린 사진의 화면 표시 ----
// 올린 원본을 그대로 다시 내려받지 않고, 임시 메시지가 실제 메시지로 바뀔 때 썸네일이 비지 않게 한다.

const SENT_FILE_LIMIT = 32;
const sentFiles = new Map<string, File>();
const fileUrls = new Map<File, string>();

export function rememberSentFile(attachmentId: string, file: File) {
    sentFiles.delete(attachmentId);
    sentFiles.set(attachmentId, file);
    for (const id of [...sentFiles.keys()].slice(0, Math.max(0, sentFiles.size - SENT_FILE_LIMIT))) sentFiles.delete(id);
}

export const sentFile = (attachmentId: string): File | undefined => sentFiles.get(attachmentId);

/// 같은 파일은 같은 주소를 쓴다. 화면이 다시 붙어도 이미 그린 이미지를 다시 읽지 않는다.
export function fileUrl(file: File): string {
    let url = fileUrls.get(file);
    if (url) fileUrls.delete(file);
    else url = URL.createObjectURL(file);
    fileUrls.set(file, url);
    for (const [old, oldUrl] of [...fileUrls].slice(0, Math.max(0, fileUrls.size - SENT_FILE_LIMIT * 2))) {
        fileUrls.delete(old);
        URL.revokeObjectURL(oldUrl);
    }
    return url;
}

/// 로그아웃·인증 만료: 이전 주체의 임시 메시지와 파일 참조를 버린다.
export function clearOutgoing() {
    byResource.clear();
    sentFiles.clear();
    for (const url of fileUrls.values()) URL.revokeObjectURL(url);
    fileUrls.clear();
    changed();
}
