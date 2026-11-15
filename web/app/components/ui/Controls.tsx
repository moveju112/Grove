import { createContext, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import { CreationDialog } from "../create/CreationDialog";
import { Icon } from "../icons";
import { PaneVisibility, usePaneVisible } from "../../state/paneVisibility";
import "./controls.css";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "../../design/Button";
import { isNarrow } from "../../state/device";

// 제목은 제목으로만 쓰고, 보조 정보는 명시적인 버튼으로 연다.
export function Panel({ title, children, ...props }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title: ReactNode }) {
    return <Stack as="section" gap={4} {...props}>
        <Heading level={2} className="panel-title">{title}</Heading>
        {children}
    </Stack>;
}

export function DetailDialog({ title, label, trigger, children, inline = false, showExpand = true, onOpenChange, ...props }: {
    title: ReactNode; label: string; children: ReactNode; inline?: boolean;
    trigger?: ReactNode;
    showExpand?: boolean;
    onOpenChange?: (open: boolean) => void;
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
    const [open, setOpen] = useState(false);
    const change = (value: boolean) => { setOpen(value); onOpenChange?.(value); };
    return <Stack align="start" {...props}>
        {inline ? <Text display="block" type="inherit" color="inherit" className="detail-heading">{title}</Text> : <Button type="button" className="ghost detail-trigger"
            aria-label={trigger === undefined ? undefined : label}
            aria-haspopup="dialog" onClick={() => change(true)}>{trigger ?? title}{showExpand && <Icon name="expand" size={14} />}</Button>}
        {inline && children}
        {open && <CreationDialog label={label} onClose={() => change(false)}>
            <Stack as="header" direction="horizontal" align="center" className="dialog-heading"><Heading level={2}>{title}</Heading>
                <Button type="button" className="ghost icon-btn" aria-label="닫기" onClick={() => change(false)}><Icon name="close" /></Button>
            </Stack>
            <Stack className="detail-content" onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-dialog-close]")) change(false);
            }}>{children}</Stack>
        </CreationDialog>}
    </Stack>;
}

// 브라우저 popover의 바깥 클릭·Escape·초점 복귀를 사용한다. 메뉴 안의 폼은 Tab 순서로 조작한다.
export function ActionMenu({ label, trigger = "⋯", children, className = "" }: {
    label: string; trigger?: ReactNode; children: ReactNode; className?: string;
}) {
    const id = useId();
    const button = useRef<HTMLButtonElement>(null);
    const popover = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    return <Stack direction="horizontal" className={`action-menu ${className}`}>
        <Button ref={button} type="button" className="ghost menu-trigger" aria-label={label} title={label}
            aria-expanded={open} popoverTarget={id} onClick={() => {
                const rect = button.current!.getBoundingClientRect();
                popover.current!.style.setProperty("--menu-left", `${Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248))}px`);
                popover.current!.style.setProperty("--menu-top", `${Math.min(rect.bottom + 4, window.innerHeight - 80)}px`);
            }}>{trigger}</Button>
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
                // Astryx는 기본 submit 유형을 명시하므로 실제 폼 소속 여부로 구분한다.
                if (action && !action.matches("[aria-haspopup=dialog]") && !(action.type === "submit" && action.form)
                    && !target.closest("dialog") && !event.defaultPrevented) popover.current!.hidePopover();
            }}>
            {children}
        </div>
    </Stack>;
}

export type DockTool = { id: string; label: string; icon?: "changes" | "file" | "terminal"; activity?: number; lazy?: boolean; content: ReactNode };

function subscribeCompact(notify: () => void) {
    const media = window.matchMedia("(max-width: 760px)");
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
}

type WorkbenchState = { open: boolean; toggle: () => void; activity: number };
const WorkbenchContext = createContext<WorkbenchState | null>(null);

// 도구 목록은 기본 화면에 늘어놓지 않고 헤더의 버튼 하나 뒤에 둔다. 진행 중 작업 수는 버튼에 표시한다.
export function ToolsTrigger() {
    const state = useContext(WorkbenchContext);
    if (!state) return null;
    return <Button type="button" className="ghost icon-btn tools-trigger" aria-label="도구 패널" title="도구 패널"
        aria-expanded={state.open} onClick={state.toggle}>
        <Icon name="panel" />
        {state.activity > 0 && <Text type="inherit" color="inherit" className="dock-activity" aria-label={`진행 중 ${state.activity}개`}>{state.activity}</Text>}
    </Button>;
}

// 각 패널을 숨긴 채 유지해 탭 전환으로 미저장 입력·결과 불명 요청을 잃지 않는다.
export function Workbench({ children, tools, label }: { children: ReactNode; tools: DockTool[]; label: string }) {
    const visible = usePaneVisible();
    const compact = useSyncExternalStore(subscribeCompact, isNarrow, () => false);
    const [active, setActive] = useState<string | null>(null);
    const [visited, setVisited] = useState<Set<string>>(() => new Set());
    const last = useRef<string | null>(null);
    const select = (tool: string) => {
        last.current = tool;
        setActive(tool);
        setVisited((previous) => new Set(previous).add(tool));
    };
    const id = useId();
    const tabs = useRef<HTMLDivElement>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const opened = active !== null && visible;
    useLayoutEffect(() => {
        const surface = dialog.current!;
        if (opened) {
            if (compact) surface.showModal();
            else surface.show();
        }
        return () => surface.close();
    }, [opened, compact]);
    const activity = tools.reduce((sum, tool) => sum + (tool.activity ?? 0), 0);
    const close = () => {
        dialog.current!.close();
        setActive(null);
        tabs.current?.closest(".workbench")?.querySelector<HTMLButtonElement>(".tools-trigger")?.focus();
    };
    const toggle = () => active ? close() : select(last.current ?? tools[0]!.id);
    return <WorkbenchContext.Provider value={{ open: !!active, toggle, activity }}>
    <Stack className={`workbench${active ? " tools-open" : ""}`}>
        <Stack className="workbench-main">{children}</Stack>
        <dialog ref={dialog} className="tool-dock" aria-label={label} onCancel={(event) => { event.preventDefault(); close(); }}>
            <Stack direction="horizontal" align="center" className="dock-bar">
                <Stack direction="horizontal" align="center" ref={tabs} className="dock-tabs" role="tablist" aria-label={label} onKeyDown={(event) => {
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
                    {tools.map((tool, index) => <Button key={tool.id} type="button" role="tab" id={`${id}-${tool.id}-tab`}
                        aria-controls={`${id}-${tool.id}`} aria-selected={active === tool.id} tabIndex={active === tool.id || (!active && index === 0) ? 0 : -1}
                        onClick={() => select(tool.id)}>{tool.icon && <Icon name={tool.icon} size={16} />}{tool.label}
                        {!!tool.activity && <Text type="inherit" color="inherit" className="dock-activity" aria-label={`진행 중 ${tool.activity}개`}>{tool.activity}</Text>}</Button>)}
                </Stack>
                {active && <Button type="button" className="ghost icon-btn" aria-label="도구 패널 닫기" onClick={close}><Icon name="close" size={16} /></Button>}
            </Stack>
            {tools.map((tool) => <div key={tool.id} id={`${id}-${tool.id}`} role="tabpanel" aria-labelledby={`${id}-${tool.id}-tab`}
                hidden={active !== tool.id} className="dock-content">
                <PaneVisibility.Provider value={visible && active === tool.id}>
                    {(tool.lazy === false || visited.has(tool.id)) && tool.content}
                </PaneVisibility.Provider>
            </div>)}
        </dialog>
    </Stack>
    </WorkbenchContext.Provider>;
}
