import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

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
            const alerts = Array.from(content.current!.querySelectorAll('[role="alert"], .save-state.error, [aria-invalid="true"]'));
            const issue = content.current!.querySelector('[role="alert"].err, .save-state.error, [aria-invalid="true"]')
                ? "error" : alerts.length ? "attention" : null;
            const target = [...new Set(Array.from(content.current!.querySelectorAll<HTMLElement>("[data-settings-target]"))
                .map((element) => element.dataset.settingsTarget!))].join(" · ");
            setNotice((previous) => previous.dirty === dirty && previous.issue === issue && previous.target === target ? previous : { dirty, issue, target });
        };
        const observer = new MutationObserver(sync);
        observer.observe(content.current!, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ["class", "role", "aria-invalid", "data-settings-unsaved", "data-settings-target"],
        });
        sync();
        return () => observer.disconnect();
    }, []);
    return <section className="settings-group" id={id} data-testid={testId}>
        <header className="settings-group-heading">
            <Icon name={icon} size={16} />
            <h2>{title}</h2>
            {(notice.dirty || notice.issue) && <span className={`settings-group-notice ${notice.issue === "error" ? "err" : ""}`} aria-live="polite">
                {[notice.dirty ? "저장 안 됨" : null, notice.issue === "error" ? "오류" : notice.issue === "attention" ? "확인 필요" : null].filter(Boolean).join(" · ")}
            </span>}
            {(notice.target || scope) && <span className="scope">{notice.target || scope}</span>}
        </header>
        <div ref={content} className="setting settings-group-content">{children}</div>
    </section>;
}
