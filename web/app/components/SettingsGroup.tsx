import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { settingsStyles } from "../design/settings.stylex";

/** 제목은 탐색 동작이 아니다. 적용 대상·미저장·오류는 본문과 함께 계속 표시한다. */
export function SettingsGroup({ title, scope, icon = "settings", id, testId, children }: {
    title: string; scope?: string; icon?: IconName;
    id?: string; testId?: string; children: ReactNode;
}) {
    const content = useRef<HTMLDivElement>(null);
    const [notice, setNotice] = useState<{ dirty: boolean; issue: "error" | "attention" | null; target: string }>({ dirty: false, issue: null, target: "" });
    useLayoutEffect(() => {
        const sync = () => {
            const dirty = Boolean(content.current!.querySelector('[data-settings-unsaved="true"]'));
            const alerts = Array.from(content.current!.querySelectorAll('[role="alert"], .save-state.error, [data-settings-issue], [aria-invalid="true"]'));
            const issue = content.current!.querySelector('[role="alert"].err, [role="alert"][data-color="error"], .save-state.error, [data-settings-issue="error"], [aria-invalid="true"]')
                ? "error" : alerts.length ? "attention" : null;
            const target = [...new Set(Array.from(content.current!.querySelectorAll<HTMLElement>("[data-settings-target]"))
                .map((element) => element.dataset.settingsTarget!))].join(" · ");
            setNotice((previous) => previous.dirty === dirty && previous.issue === issue && previous.target === target ? previous : { dirty, issue, target });
        };
        const observer = new MutationObserver(sync);
        observer.observe(content.current!, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ["class", "role", "aria-invalid", "data-color", "data-settings-issue", "data-settings-unsaved", "data-settings-target"],
        });
        sync();
        return () => observer.disconnect();
    }, []);
    const compact = id === "setting-theme" || id === "setting-font" || id === "setting-enter" || id === "setting-running-send";
    return <Card id={id} data-testid={testId} data-ui="settings-group" role="region" aria-label={title}
        padding={0} xstyle={settingsStyles.group}>
        <Stack as="header" direction="horizontal" gap={2} padding={3} vAlign="center" xstyle={settingsStyles.heading}>
            <Icon name={icon} size={16} />
            <Heading level={2} type="panel" xstyle={settingsStyles.title}>{title}</Heading>
            {(notice.dirty || notice.issue) && <Text type="supporting" aria-live="polite" color={notice.issue === "error" ? "error" : "inherit"}
                xstyle={settingsStyles.notice}>
                {[notice.dirty ? "저장 안 됨" : null, notice.issue === "error" ? "오류" : notice.issue === "attention" ? "확인 필요" : null].filter(Boolean).join(" · ")}
            </Text>}
            {(notice.target || scope) && <Text type="supporting" xstyle={settingsStyles.scope}>{notice.target || scope}</Text>}
        </Stack>
        <Stack ref={content} gap={2} padding={3} direction={compact ? "horizontal" : "vertical"}
            wrap={compact ? "wrap" : undefined} align={compact ? "center" : "stretch"} xstyle={settingsStyles.content}>
            {children}
        </Stack>
    </Card>;
}
