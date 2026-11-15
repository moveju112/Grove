import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useRef } from "react";
import type { GitReview } from "./types";
import { ServerActionButton } from "../pwa/ServerActionButton";

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
            <GroveHeading level={2} color="inherit" id="git-confirm-title">{discard ? "파일 변경 버리기 확인" : "stash pop 확인"}</GroveHeading>
            <GroveText as="p" display="block" type="inherit" color="inherit" id="git-confirm-warning">{discard
                ? "선택한 tracked 파일의 index·작업 트리를 HEAD로 되돌립니다. 미커밋 변경은 복구할 수 없을 수 있습니다. untracked 파일은 삭제하지 않습니다."
                : "선택한 stash를 index·작업 트리에 적용하고 성공하면 목록에서 삭제합니다. 충돌하거나 적용에 실패하면 stash를 보존하며 충돌 상태를 자동으로 되돌리지 않습니다."}</GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">프로젝트 <code>{projectId}</code></GroveText>
            {review.action.operation === "stash_pop" && <GroveText as="p" display="block" type="inherit" color="inherit">stash <code>{review.action.stash_oid}</code></GroveText>}
            <ul>{review.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
            <pre className="diff">{review.summary}</pre>
            <GroveText as="p" display="block" type="supporting" color="secondary">확인 후 상태가 바뀌면 실행하지 않습니다.</GroveText>
            <GroveStack direction="horizontal" align="center" className="inline">
                <GroveButton autoFocus onClick={onCancel}>취소</GroveButton>
                <ServerActionButton onClick={onConfirm}>{discard ? "확인하고 변경 버리기" : "확인하고 stash pop"}</ServerActionButton>
            </GroveStack>
        </dialog>
    );
}
