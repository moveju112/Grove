import { useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { CreationDialog } from "../create/CreationDialog";
import { Icon } from "../icons";
import { PaneVisibility, usePaneVisible } from "../../state/paneVisibility";
import "./controls.css";

// 제목은 제목으로만 쓰고, 보조 정보는 명시적인 버튼으로 연다.
export function Panel({ title, children, ...props }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title: ReactNode }) {
    return <section {...props}>
        <h2 className="panel-title">{title}</h2>
        {children}
    </section>;
}

export function DetailDialog({ title, label, trigger, children, inline = false, onOpenChange, ...props }: {
    title: ReactNode; label: string; children: ReactNode; inline?: boolean;
    trigger?: ReactNode;
    onOpenChange?: (open: boolean) => void;
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
    const [open, setOpen] = useState(false);
    const change = (value: boolean) => { setOpen(value); onOpenChange?.(value); };
    return <div {...props}>
        {inline ? <div className="detail-heading">{title}</div> : <button type="button" className="ghost detail-trigger"
            aria-label={trigger === undefined ? undefined : label}
            aria-haspopup="dialog" onClick={() => change(true)}>{trigger ?? title}<Icon name="expand" size={14} /></button>}
        {inline && children}
        {open && <CreationDialog label={label} onClose={() => change(false)}>
            <header className="dialog-heading"><h2>{title}</h2>
                <button type="button" className="ghost icon-btn" aria-label="닫기" onClick={() => change(false)}><Icon name="close" /></button>
            </header>
            <div className="detail-content" onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-dialog-close]")) change(false);
            }}>{children}</div>
        </CreationDialog>}
    </div>;
}

// 브라우저 popover의 바깥 클릭·Escape·초점 복귀를 사용한다. 메뉴 안의 폼은 Tab 순서로 조작한다.
export function ActionMenu({ label, trigger = "⋯", children, className = "" }: {
    label: string; trigger?: ReactNode; children: ReactNode; className?: string;
}) {
    const id = useId();
    const button = useRef<HTMLButtonElement>(null);
    const popover = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    return <div className={`action-menu ${className}`}>
        <button ref={button} type="button" className="ghost menu-trigger" aria-label={label} title={label}
            aria-expanded={open} popoverTarget={id} onClick={() => {
                const rect = button.current!.getBoundingClientRect();
                popover.current!.style.setProperty("--menu-left", `${Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248))}px`);
                popover.current!.style.setProperty("--menu-top", `${Math.min(rect.bottom + 4, window.innerHeight - 80)}px`);
            }}>{trigger}</button>
        <div ref={popover} id={id} popover="auto" className="action-popover" role="group" aria-label={label}
            onToggle={(event) => {
                const visible = event.newState === "open";
                setOpen(visible);
                if (visible) {
                    const rect = button.current!.getBoundingClientRect();
                    const height = popover.current!.getBoundingClientRect().height;
                    const top = rect.bottom + height + 12 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4);
                    popover.current!.style.setProperty("--menu-top", `${top}px`);
                }
            }}
            onClick={(event) => {
                const target = event.target as HTMLElement;
                const action = target.closest("button");
                if (action && !action.matches("[aria-haspopup=dialog], [type=submit]") && !target.closest("dialog") && !event.defaultPrevented) popover.current!.hidePopover();
            }}>
            {children}
        </div>
    </div>;
}

export type DockTool = { id: string; label: string; icon?: "changes" | "file" | "terminal"; activity?: number; lazy?: boolean; content: ReactNode };

// 각 패널을 숨긴 채 유지해 탭 전환으로 미저장 입력·결과 불명 요청을 잃지 않는다.
export function Workbench({ children, tools, label }: { children: ReactNode; tools: DockTool[]; label: string }) {
    const visible = usePaneVisible();
    const [active, setActive] = useState<string | null>(null);
    const [visited, setVisited] = useState<Set<string>>(() => new Set());
    const select = (tool: string) => {
        setActive(tool);
        setVisited((previous) => new Set(previous).add(tool));
    };
    const id = useId();
    const tabs = useRef<HTMLDivElement>(null);
    return <div className={`workbench${active ? " tools-open" : ""}`}>
        <div className="workbench-main">{children}</div>
        <aside className="tool-dock" aria-label={label}>
            <div className="dock-bar">
                <div ref={tabs} className="dock-tabs" role="tablist" aria-label={label} onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    const buttons = [...tabs.current!.querySelectorAll<HTMLButtonElement>("[role=tab]")];
                    const current = buttons.indexOf(event.target as HTMLButtonElement);
                    if (current < 0) return;
                    event.preventDefault();
                    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                        : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                    select(tools[next]!.id);
                    buttons[next]!.focus();
                }}>
                    {tools.map((tool, index) => <button key={tool.id} type="button" role="tab" id={`${id}-${tool.id}-tab`}
                        aria-controls={`${id}-${tool.id}`} aria-selected={active === tool.id} tabIndex={active === tool.id || (!active && index === 0) ? 0 : -1}
                        onClick={() => select(tool.id)}>{tool.icon && <Icon name={tool.icon} size={16} />}{tool.label}
                        {!!tool.activity && <span className="dock-activity" aria-label={`진행 중 ${tool.activity}개`}>{tool.activity}</span>}</button>)}
                </div>
                {active && <button type="button" className="ghost icon-btn" aria-label="도구 패널 닫기" onClick={() => {
                    tabs.current?.querySelector<HTMLButtonElement>("[aria-selected=true]")?.focus();
                    setActive(null);
                }}><Icon name="close" size={16} /></button>}
            </div>
            {tools.map((tool) => <div key={tool.id} id={`${id}-${tool.id}`} role="tabpanel" aria-labelledby={`${id}-${tool.id}-tab`}
                hidden={active !== tool.id} className="dock-content">
                <PaneVisibility.Provider value={visible && active === tool.id}>
                    {(!tool.lazy || visited.has(tool.id)) && tool.content}
                </PaneVisibility.Provider>
            </div>)}
        </aside>
    </div>;
}
