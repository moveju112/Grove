import { Heading } from "@astryxdesign/core/Heading";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useId, useRef, useState } from "react";
import type { ToolCallRow } from "../../api/generated";
import { ApprovalSubmission, type DecisionState } from "./decision";
import {
    approvalExpired, approvalKey, displayText, effectLabels, projectApproval, record, sameApproval, statusLabels,
    type ApprovalDecision, type ApprovalEffect, type ApprovalFailure, type ApprovalIdentity, type ApprovalRequest,
} from "./projection";
import { Card } from "@astryxdesign/core/Card";
import { KeyValues } from "../../design/KeyValues";

export type ApprovalFeedback = ApprovalIdentity & (
    | { phase: "pending" }
    | { phase: "failed"; failure: ApprovalFailure }
);

export type ApprovalCardProps = {
    call: ToolCallRow;
    effect: ApprovalEffect | null;
    choices: readonly ApprovalDecision[];
    onDecision: (request: ApprovalRequest) => Promise<ToolCallRow>;
    feedback?: ApprovalFeedback;
    onRefresh?: (identity: ApprovalIdentity) => Promise<void>;
    blockedReason?: string | null;
    /** 새 요청에서 명시적으로 초점을 이동할 때만 지정한다. */
    focusOnMount?: boolean;
};

/** API/store에 의존하지 않는다. 호출부는 rejection을 삼키지 않고 ToolCallRow를 반환한다. */
export function ApprovalCard(props: ApprovalCardProps) {
    return <ApprovalCardInstance key={approvalKey(props.call)} {...props} />;
}

function ApprovalCardInstance({ call, effect, choices, onDecision, feedback, onRefresh, focusOnMount, blockedReason }: ApprovalCardProps) {
    const title = useId();
    const statusId = useId();
    const heading = useRef<HTMLHeadingElement>(null);
    const deny = useRef<HTMLButtonElement>(null);
    const [state, setState] = useState<DecisionState>({ phase: "idle" });
    const [expired, setExpired] = useState(() => approvalExpired(call.expires_at, Date.now()));
    const [refreshing, setRefreshing] = useState(false);
    const [refreshFailed, setRefreshFailed] = useState(false);
    const refreshLock = useRef(false);
    const submission = useRef<ApprovalSubmission | null>(null);

    // StrictMode의 effect 재실행에서도 폐기된 인스턴스를 재사용하지 않는다.
    useEffect(() => {
        const current = new ApprovalSubmission(call, setState);
        submission.current = current;
        return () => { current.dispose(); submission.current = null; };
    }, [call.id, call.session_id, call.revision]);

    useEffect(() => {
        if (focusOnMount) (deny.current ?? heading.current)?.focus();
    }, [focusOnMount]);

    useEffect(() => {
        setExpired(approvalExpired(call.expires_at, Date.now()));
        if (!call.expires_at) return;
        const remaining = Date.parse(call.expires_at) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) return;
        // 긴 TTL도 setTimeout의 32비트 범위를 넘지 않게 다시 계산한다.
        let timer: ReturnType<typeof setTimeout>;
        const tick = () => {
            const left = Date.parse(call.expires_at!) - Date.now();
            if (left <= 0) setExpired(true);
            else timer = setTimeout(tick, Math.min(left, 2_147_483_647));
        };
        timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
        return () => clearTimeout(timer);
    }, [call.expires_at]);

    const external = feedback && sameApproval(call, feedback) ? feedback : undefined;
    const pending = state.phase === "pending" || external?.phase === "pending";
    const failure = external?.phase === "failed" ? external.failure : state.phase === "failed" ? state.failure : null;
    const effective = state.phase === "settled" && call.status === "pending_approval" ? state.call : call;
    const closed = effective.status !== "pending_approval";
    const disabled = pending || !!failure || expired || closed || !call.needs_approval || !!blockedReason;
    const projection = projectApproval(call);
    const effectInfo = effect ? effectLabels[effect] : null;
    const status = pending ? "승인 선택 처리 중 · 실행 결과 미확정"
        : failure ? failure.message
        : closed ? statusLabels[effective.status] ?? "알 수 없는 상태 · 최신 상태를 확인하세요"
        : expired ? "승인 만료 · 최신 상태를 확인하세요"
        : !call.needs_approval ? "사용자 승인 대상이 아닙니다"
        : blockedReason ?? "승인 대기 · 아직 실행하지 않았습니다";
    const resultError = record(record(effective.result).error);
    const policyBlocked = effective.status === "failed"
        && ["policy_denied", "read_only", "forbidden"].includes(String(resultError.code));

    const submit = (decision: ApprovalDecision) => {
        // 타이머 실행이 지연된 탭에서도 클릭 시 만료를 다시 확인한다.
        if (disabled || !choices.includes(decision) || (!effect && decision !== "deny")) return;
        if (approvalExpired(call.expires_at, Date.now())) { setExpired(true); return; }
        void submission.current?.submit({ id: call.id, session_id: call.session_id, revision: call.revision, decision }, onDecision);
    };
    const refresh = async () => {
        if (!onRefresh || refreshLock.current) return;
        refreshLock.current = true;
        setRefreshing(true);
        setRefreshFailed(false);
        try {
            await onRefresh({ id: call.id, session_id: call.session_id, revision: call.revision });
        } catch {
            setRefreshFailed(true);
        } finally {
            refreshLock.current = false;
            setRefreshing(false);
        }
    };

    return (
        <Card variant="orange" padding={3} role="region" aria-labelledby={title} aria-describedby={statusId}
            aria-busy={pending} data-testid="approval" data-approval-id={call.id} data-revision={call.revision}>
            <GroveStack gap={2}>
            <Heading level={3} id={title} tabIndex={-1} ref={heading}>{call.name === "computer" ? "PC 제어" : displayText(call.name, 80)} 승인 요청</Heading>
            {call.name === "computer" ? (
                <GroveText as="p" display="block" type="inherit" color="inherit">서버 PC 화면 공유·조작을 이 대화에서 계속 허용합니다.</GroveText>
            ) : <>
                <KeyValues data-testid="approval-target" items={projection.fields.map((field) => [field.label, <code>{field.value}</code>])} />
                <GroveText as="p" display="block" type="inherit" color="inherit" data-testid="approval-effect">{effectInfo?.consequence ?? "도구 분류를 확인할 수 없어 승인할 수 없습니다."}</GroveText>
                {projection.notices.map((notice) => <GroveText as="p" display="block" type="supporting" color="secondary" key={notice}>{notice}</GroveText>)}
                {choices.includes("approve_session") && <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="approval-allowed-scope">대화 승인은 이 대화의 <code>{displayText(call.name, 80)}</code> 도구 전체에 적용됩니다.</GroveText>}
            </>}
            <GroveText as="p" display="block" type="inherit" color="inherit" id={statusId} role={failure || policyBlocked ? "alert" : "status"} aria-live={failure || policyBlocked ? "assertive" : "polite"} aria-atomic="true" data-testid="approval-status">
                {policyBlocked ? "권한 또는 도구 정책으로 실행이 차단되었습니다." : !disabled && !pending ? null : status}
            </GroveText>
            {effective.approval_scope && <GroveText as="p" display="block" type="inherit" color="inherit" data-testid="approval-scope">{effective.approval_scope === "once" ? "이번만 승인" : effective.approval_scope === "session" ? "이 대화에서 허용됨" : effective.approval_scope === "policy" ? "정책(tools.allow)으로 허용" : "허용 범위 확인 필요"}</GroveText>}
            <GroveStack gap={2} direction="horizontal" align="center" wrap="wrap">
                {choices.includes("approve_session") && <GroveButton disabled={disabled || !effect} onClick={() => submit("approve_session")}>이 대화에서 승인</GroveButton>}
                {choices.includes("approve") && <GroveButton variant={choices.includes("approve_session") ? "secondary" : "primary"} disabled={disabled || !effect} onClick={() => submit("approve")}>이번만 승인</GroveButton>}
                {choices.includes("deny") && <GroveButton ref={deny} variant="secondary" disabled={disabled} onClick={() => submit("deny")}>거부</GroveButton>}
                {onRefresh && (failure || expired || closed) && <GroveButton variant="secondary" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "최신 상태 확인 중" : "최신 상태 확인"}</GroveButton>}
            </GroveStack>
            {refreshFailed && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">최신 상태를 가져오지 못했습니다. 승인·실행 결과는 확정되지 않았습니다.</GroveText>}
            </GroveStack>
        </Card>
    );
}
