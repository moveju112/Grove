import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api/client";
import type { ToolCallRow } from "../api/generated";
import { Button } from "../design/Button";
import { TextArea } from "../design/Fields";
import { CHAT_COLUMN_WIDTH, chatLayout } from "./chat-layout.stylex";
import { Icon } from "./icons";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { questionStyles as styles } from "./question.stylex";

type Question = { question: string; options: { label: string; description?: string }[]; multi_select: boolean; allow_free_text: boolean };
type Answer = { choices: string[]; text: string | null } | { cancel: true };

export function QuestionCard({ call, act, onAnswered }: {
    call: ToolCallRow; act: (f: () => Promise<unknown>) => Promise<void>; onAnswered: () => void;
}) {
    const q = call.target as Question;
    const [picked, setPicked] = useState<string[]>([]);
    const [text, setText] = useState("");
    const [cursor, setCursor] = useState(0);
    const [sending, setSending] = useState(false);
    const pending = useRef(false);
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const titleId = useId();
    const note = q.allow_free_text && text.trim() ? text : null;

    function send(answer: Answer) {
        if (pending.current) return;
        pending.current = true;
        setSending(true);
        void act(async () => {
            try {
                await api.post(`/tool-calls/${call.id}/answer`, { expected_revision: call.revision, ...answer });
            } catch (error) {
                pending.current = false;
                setSending(false);
                throw error;
            }
            onAnswered();
        });
    }

    function choose(label: string) {
        if (q.multi_select) {
            setPicked((prev) => prev.includes(label) ? prev.filter((value) => value !== label) : [...prev, label]);
        } else {
            send({ choices: [label], text: note });
        }
    }

    function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
        const count = q.options.length;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            buttons.current[(index + (event.key === "ArrowDown" ? 1 : -1) + count) % count]?.focus();
        } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= count && !event.repeat) {
            event.preventDefault();
            const target = buttons.current[Number(event.key) - 1];
            target?.focus();
            target?.click();
        }
    }

    const Option = q.multi_select ? Button : ServerActionButton;
    return <Card padding={0} width="100%" maxWidth={CHAT_COLUMN_WIDTH} xstyle={chatLayout.centered}>
        <Stack gap={0} role="group" aria-labelledby={titleId} aria-busy={sending} data-testid="question">
            <Stack padding={3} gap={2}>
                <Stack direction="horizontal" align="center" justify="between" gap={2}>
                    <Stack direction="horizontal" align="center" gap={1}>
                        <Icon name="help" size={14} /><Text type="supporting" color="secondary">질문{q.multi_select && " · 여러 개 선택 가능"}</Text>
                    </Stack>
                    <ServerActionButton type="button" appearance="link" density="compact" disabled={sending}
                        onClick={() => send({ cancel: true })}>답하지 않고 닫기</ServerActionButton>
                </Stack>
                <Text id={titleId} weight="semibold" xstyle={styles.title}>{q.question}</Text>
                {!!q.options.length && <Stack gap={0} role="group" aria-label="답변 선택">
                    {q.options.map(({ label, description }, index) => <Option key={label} type="button" appearance="navigation"
                        aria-label={label} aria-describedby={description ? `${titleId}-${index}` : undefined}
                        aria-pressed={q.multi_select ? picked.includes(label) : undefined}
                        data-current={cursor === index} xstyle={styles.option} disabled={sending}
                        ref={(node) => { buttons.current[index] = node; }}
                        onFocus={() => setCursor(index)} onKeyDown={(e) => move(e, index)} onClick={() => choose(label)}>
                        <Text as="span" aria-hidden="true" xstyle={styles.number}>{index + 1}</Text>
                        <Stack as="span" gap={0} xstyle={styles.copy}>
                            <Text type="inherit" color="inherit">{label}</Text>
                            {description && <Text id={`${titleId}-${index}`} type="supporting" color="secondary">{description}</Text>}
                        </Stack>
                        {q.multi_select ? picked.includes(label) && <Icon name="check" size={14} />
                            : cursor === index && <Text aria-hidden="true" color="secondary">↵</Text>}
                    </Option>)}
                </Stack>}
                {q.allow_free_text && <TextArea label="직접 입력" rows={2} value={text} onChange={setText} isDisabled={sending} />}
            </Stack>
            <Stack direction="horizontal" align="center" justify="between" wrap="wrap" gap={2} paddingInline={3} paddingBlock={2} xstyle={styles.footer}>
                {!!q.options.length && <Text type="supporting" color="secondary" xstyle={styles.hint}>
                    {q.multi_select ? "↑ ↓ 이동 · Space 선택" : "↑ ↓ 이동 · Enter 답하기"}
                </Text>}
                {(q.multi_select || q.allow_free_text) && <ServerActionButton type="button" density="compact" disabled={sending || (!picked.length && !note)}
                    onClick={() => send({ choices: picked, text: note })}>답하기</ServerActionButton>}
            </Stack>
        </Stack>
    </Card>;
}
