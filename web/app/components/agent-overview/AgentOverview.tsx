import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { CodeBlock } from "../../design/CodeBlock";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { DetailDialog } from "../ui/Controls";
import { getAgentOverview, type AgentOverviewData, type OverviewProfile, type OverviewRole, type OverviewTarget } from "../../api/agentOverview";
import { subscribeQuery, useLive } from "../../state/store";

type View = { key: string; status: "loading" | "error" } | { key: string; status: "ready"; data: AgentOverviewData };

// 기존 cache의 이벤트 무효화·재접속을 구독하되, 닫힌 화면의 이전 응답은 표시하지 않는다.
function useOverview(target: OverviewTarget, connected: boolean) {
    const key = JSON.stringify([target.projectId ?? null, target.sessionId ?? null]);
    const [view, setView] = useState<View>({ key, status: "loading" });
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (!connected) {
            setView({ key, status: "loading" });
            return;
        }
        let mounted = true;
        let sequence = 0;
        let scheduled: Promise<AgentOverviewData> | undefined;
        const read = () => {
            // 같은 이벤트 묶음·초기 구독은 한 번만 조회한다. 진행 중인 이전 응답보다 새 조회가 우선한다.
            if (scheduled) return scheduled;
            const version = ++sequence;
            setView({ key, status: "loading" });
            scheduled = Promise.resolve().then(() => {
                scheduled = undefined;
                return getAgentOverview(target);
            }).then((data) => {
                if (mounted && sequence === version) setView({ key, status: "ready", data });
                return data;
            }, (error: unknown) => {
                if (mounted && sequence === version) setView({ key, status: "error" });
                throw error;
            });
            return scheduled;
        };
        const suffix = `agent-overview:${key}`;
        const unsubscribe = ["settings", "definitions", "profiles", "agent-runs", ...(target.sessionId ? [`turns:${target.sessionId}`] : [])]
            .map((prefix) => subscribeQuery(`${prefix}:${suffix}`, read, () => {}));
        // cache가 남은 재진입에서도 지금 대상을 새로 읽는다.
        void read().catch(() => {});
        return () => { mounted = false; sequence++; unsubscribe.forEach((stop) => stop()); };
        // 식별자만 조회 계약에 포함한다.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, retry, connected]);
    return { view: view.key === key ? view : { key, status: "loading" } as View, reload: () => setRetry((n) => n + 1) };
}

function subscribeNetwork(notify: () => void) {
    window.addEventListener("online", notify);
    window.addEventListener("offline", notify);
    return () => {
        window.removeEventListener("online", notify);
        window.removeEventListener("offline", notify);
    };
}

const SOURCE: Record<string, string> = { default: "기본값", server: "서버 전체", project: "이 프로젝트", session: "이 대화" };
const AVAILABLE: Record<OverviewRole["availability"], string> = {
    disabled: "비활성", unknown: "확인 불가", delegation_off: "위임 금지", policy_denied: "도구 정책상 금지",
    tools_disabled: "부모 턴 도구 꺼짐", available: "현재 정책상 사용 가능", depth_limit: "깊이 한도 도달", needs_session: "대화에서 사용 가능 여부 확인 필요",
};
function Profile({ value }: { value: OverviewProfile }) {
    switch (value.status) {
        case "configured": return <>{value.name} · {value.model} (설정됨 · 연결·실행 미확인)</>;
        case "disabled": return <>{value.name} · {value.model} (비활성 · 선택 필요)</>;
        case "missing": return <>삭제됐거나 없는 모델 · 선택 필요</>;
        case "unset": return <>미설정 · 선택 필요</>;
        default: return <>모델 상태 확인 불가</>;
    }
}

export function AgentOverview({ target, onEdit, onLayoutChange }: {
    target: OverviewTarget; onEdit: (id: string) => void; onLayoutChange?: (ready: boolean) => void;
}) {
    const connection = useLive((live) => live.status);
    const online = useSyncExternalStore(subscribeNetwork, () => navigator.onLine, () => true);
    const connected = connection === "live" && online;
    const { view, reload } = useOverview(target, connected);
    const ready = connected && view.status === "ready" ? view.data : null;
    // 실제 개요가 commit된 시점만 알린다. 오류 화면도 높이가 확정된 종료 상태다.
    useLayoutEffect(() => {
        onLayoutChange?.(connected && view.status !== "loading");
        return () => onLayoutChange?.(false);
    }, [onLayoutChange, connected, view.key, view.status]);
    return <GroveStack as="section" gap={2} data-testid="agent-overview" aria-label="역할·모델·실행 규칙 개요">
        <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="overview-target">{target.sessionId ? "이 대화 기준" : target.projectId ? "이 프로젝트 기준" : "서버 전체 기준"} · 정의 편집은 서버 전체에 적용</GroveText>
        {!connected ? <GroveText as="p" display="block" type="inherit" color="inherit" role="status">연결 확인 중 · 이전 조회값은 현재 설정으로 표시하지 않습니다.</GroveText>
            : view.status === "error" ? <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">개요를 읽지 못했습니다. 인증·조회 대상을 확인하고 다시 조회하세요.</GroveText>
                : view.status === "loading" ? <GroveText as="p" display="block" type="inherit" color="inherit" role="status">개요를 읽는 중입니다.</GroveText> : null}
        <Collapsible trigger="모델·실행 정보" defaultIsOpen={false}>
        <GroveStack gap={3}>
        {ready && <>
            <GroveHeading level={4} color="inherit">모델 연결</GroveHeading>
            <GroveText as="p" display="block" type="inherit" color="inherit">현재 부모 턴: {ready.parent.status === "active"
                ? <><Profile value={ready.parent.profile} /> · 도구 {ready.parent.tools_enabled ? "켜짐" : "꺼짐"}</>
                : ready.parent.status === "no_session" ? "대화 대상 없음 · 상속 모델 확인 불가" : "활성 턴 없음 · 상속 모델 아직 미정"}</GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">다음 요청 기본값: <Profile value={ready.next_request_default} /> · 출처: {SOURCE[ready.next_request_default.source] ?? "확인 불가"}</GroveText>
            <GroveHeading level={4} color="inherit">위임 실행 규칙</GroveHeading>
            <GroveText as="p" display="block" type="inherit" color="inherit">agents.delegation: {ready.delegation.mode === "off" ? "off · 금지" : ready.delegation.mode === "ask" ? "ask · 승인 요청" : ready.delegation.mode === "auto" ? "auto · 자동" : "확인 불가"} · 출처: {SOURCE[ready.delegation.source] ?? "확인 불가"}</GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">현재 대화의 시작 승인: {({ blocked: "정책상 금지", auto: "자동 허용", ask: "승인 필요", unknown: "확인 불가 · 대화에서 확인 필요" })[ready.delegation.approval]}</GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">최대 깊이 {ready.limits.max_depth} · 부모 대화당 동시 실행 {ready.limits.max_per_parent} · 서버 전체 동시 실행 {ready.limits.max_running}</GroveText>
            <GroveText as="p" display="block" type="supporting" color="secondary">부모 취소 시 자식도 취소 · 서버 재시작 후 자동 재실행하지 않습니다.</GroveText>
            <GroveHeading level={4} color="inherit">등록된 역할 {ready.roles.length}개</GroveHeading>
            {ready.roles.map((role) => <Card key={role.id} padding={3} role="article" aria-label={`역할 ${role.id}`}><GroveStack gap={2}>
                <GroveHeading level={4} color="inherit">{role.name} <GroveText type="supporting" color="secondary">{role.id}</GroveText></GroveHeading>
                <GroveText as="p" display="block" type="inherit" color="inherit">{role.builtin ? "기본 내장" : "사용자 정의"} · {role.modified_fields.length ? `override 수정됨 (${role.modified_fields.join(", ")})` : "원문 변경 없음"} · {role.enabled ? "활성" : "비활성"} · {AVAILABLE[role.availability] ?? "확인 불가"}</GroveText>
                <DetailDialog label="역할 지침" title={role.enabled ? "현재 적용 지침" : "비활성 정의 지침 (실행에 사용 안 함)"}>
                    <GroveText as="p" display="block" type="inherit" color="inherit">{role.description}</GroveText>
                    <CodeBlock aria-label={`${role.id} 지침`} code={role.body} />
                </DetailDialog>
                <GroveButton variant="secondary" aria-label={`${role.id} 기존 편집 열기`} onClick={() => onEdit(role.id)}>편집</GroveButton>
            </GroveStack></Card>)}
        </>}
        <GroveButton variant="secondary" disabled={!connected || view.status === "loading"} onClick={reload}>개요 다시 조회</GroveButton>
        </GroveStack>
        </Collapsible>
    </GroveStack>;
}
