import { useEffect, useRef } from "react";
import type { GitReview } from "./types";

export function GitConfirmation({ projectId, review, onConfirm, onCancel }: {
    projectId: string;
    review: GitReview;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current?.showModal(); }, []);
    const discard = review.action.operation === "discard";
    return (
        <dialog ref={dialog} aria-labelledby="git-confirm-title" aria-describedby="git-confirm-warning"
            onCancel={(event) => { event.preventDefault(); onCancel(); }}>
            <h2 id="git-confirm-title">{discard ? "파일 변경 버리기 확인" : "stash pop 확인"}</h2>
            <p id="git-confirm-warning">{discard
                ? "선택한 tracked 파일의 index·작업 트리를 HEAD로 되돌립니다. 미커밋 변경은 복구할 수 없을 수 있습니다. untracked 파일은 삭제하지 않습니다."
                : "선택한 stash를 index·작업 트리에 적용하고 성공하면 목록에서 삭제합니다. 충돌하거나 적용에 실패하면 stash를 보존하며 충돌 상태를 자동으로 되돌리지 않습니다."}</p>
            <p>프로젝트 <code>{projectId}</code></p>
            {review.action.operation === "stash_pop" && <p>stash <code>{review.action.stash_oid}</code></p>}
            <ul>{review.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
            <pre className="diff">{review.summary}</pre>
            <p className="muted small">확인 후 상태가 바뀌면 실행하지 않습니다.</p>
            <div className="inline">
                <button autoFocus onClick={onCancel}>취소</button>
                <button onClick={onConfirm}>{discard ? "확인하고 변경 버리기" : "확인하고 stash pop"}</button>
            </div>
        </dialog>
    );
}
