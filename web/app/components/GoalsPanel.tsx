import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { StatusBadge } from "../design/StatusBadge";
import { useState } from "react";
import { ApiError, api } from "../api/client";
import { Panel } from "./ui/Controls";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useServerBlockReason } from "./pwa/lifecycle";
import { BooleanSelect } from "./BooleanSelect";
import { TextInput } from "../design/Fields";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";

type Goal = { id: string; title: string; status: "pending" | "in_progress" | "done" | "cancelled"; revision: number };

/// 대화별 Goal 목록. 미완료 항목은 다음 요청에서 모델에 알려 줄 뿐, 자동으로 실행하지 않는다.
export function GoalsPanel({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
    const serverBlocked = useServerBlockReason();
    const q = useQuery<{ goals: Goal[] }>(`goals:${sessionId}`, () => api.get(`/sessions/${sessionId}/goals`));
    const [title, setTitle] = useState("");
    const [err, setErr] = useState<string | null>(null);
    // 저장 중에는 누른 값을 먼저 보여 준다. 실패하면 서버 값으로 돌아간다.
    const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
    const goals = q.data?.goals ?? [];
    const open = goals.filter((g) => g.status === "pending" || g.status === "in_progress").length;
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? (e.code === "revision_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 최신 목록을 불러왔습니다" : e.message) : "Goal 변경 실패");
        }
        q.reload();
    };
    const move = (i: number) => {
        const ids = goals.map((g) => g.id);
        [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
        void act(() => api.post(`/sessions/${sessionId}/goals/reorder`, { ids }));
    };
    return (
        <Panel data-testid="goals-panel" title={`Goal${goals.length > 0 ? ` · 남은 ${open}/${goals.length}` : ""}`}>
            {err && <Text as="p" display="block" type="inherit" color="error" role="alert">{err}</Text>}
            <List density="compact" edge="flush" hasDividers>
                {goals.map((g, i) => (
                    <ListItem key={g.id} data-testid="goal" data-status={g.status}
                        endContent={<>
                            {g.status === "in_progress" && <StatusBadge status="running">진행 중</StatusBadge>}
                            {i > 0 && !disabled && <ServerActionButton variant="secondary" density="compact" aria-label={`${g.title} 위로`} onClick={() => move(i)}>↑</ServerActionButton>}
                        </>}
                        label={
                        <BooleanSelect label={g.title} trueLabel="완료" falseLabel="미완료"
                                value={optimistic[g.id] ?? g.status === "done"}
                                disabled={disabled || g.status === "cancelled" || !!serverBlocked}
                                onChange={(done) => {
                                    setOptimistic((o) => ({ ...o, [g.id]: done }));
                                    void act(() =>
                                        api.patch(`/sessions/${sessionId}/goals/${g.id}`, { expected_revision: g.revision, status: done ? "done" : "pending" }),
                                    ).finally(() =>
                                        setOptimistic((o) => {
                                            const { [g.id]: _, ...rest } = o;
                                            return rest;
                                        }),
                                    );
                                }}
                            />
                        } />
                ))}
            </List>
            {!disabled && (
                <GroveStack as="form"
                    gap={1.5} direction="horizontal" align="center"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                            await api.post(`/sessions/${sessionId}/goals`, { title });
                            setTitle("");
                        });
                    }}
                >
                    <TextInput size="sm" label="새 Goal" isLabelHidden placeholder="할 일 추가" value={title} onChange={setTitle} />
                    <ServerActionButton type="submit" disabled={!title.trim()}>추가</ServerActionButton>
                </GroveStack>
            )}
        </Panel>
    );
}
