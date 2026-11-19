import { createContext, useContext, useId, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CreationDialog } from "../create/CreationDialog";
import { Icon } from "../icons";
import { PaneVisibility, usePaneVisible } from "../../state/paneVisibility";
import { Stack, type StackProps } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button, type ButtonProps } from "../../design/Button";
import { isNarrow } from "../../state/device";
import { Popover } from "@astryxdesign/core/Popover";
import { Drawer } from "@astryxdesign/core/Drawer";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Badge } from "@astryxdesign/core/Badge";
import { Card, type CardVariant } from "@astryxdesign/core/Card";
import { controlStyles } from "./controls.stylex";
import { chatLayout } from "../chat-layout.stylex";

// 제목은 제목으로만 쓰고, 보조 정보는 명시적인 버튼으로 연다.
export function Panel({ title, children, ...props }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title: ReactNode }) {
    return <Stack as="section" gap={4} {...props}>
        <Heading level={2} type="panel">{title}</Heading>
        {children}
    </Stack>;
}

export function DetailDialog({ title, label, trigger, children, inline = false, showExpand = true, onOpenChange, surface, appearance = "disclosure", ...props }: {
    title: ReactNode; label: string; children: ReactNode; inline?: boolean;
    trigger?: ReactNode;
    showExpand?: boolean;
    onOpenChange?: (open: boolean) => void;
    surface?: CardVariant;
    appearance?: ButtonProps["appearance"];
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
    const [open, setOpen] = useState(false);
    const change = (value: boolean) => { setOpen(value); onOpenChange?.(value); };
    const body = <>
        {inline ? <Text display="block" type="supporting" color="secondary">{title}</Text> : <Button type="button" variant="secondary" appearance={appearance}
            aria-label={trigger === undefined ? undefined : label}
            aria-haspopup="dialog" onClick={() => change(true)}>{trigger ?? title}{showExpand && <Icon name="expand" size={14} />}</Button>}
        {inline && children}
        {open && <CreationDialog label={label} onClose={() => change(false)}>
            <Stack as="header" direction="horizontal" align="center" justify="between" gap={3}><Heading level={2}>{title}</Heading>
                <Button type="button" variant="secondary" appearance="icon" aria-label="닫기" onClick={() => change(false)}><Icon name="close" /></Button>
            </Stack>
            <Stack gap={2} maxWidth="100%" onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-dialog-close]")) change(false);
            }}>{children}</Stack>
        </CreationDialog>}
    </>;
    return surface ? <Card variant={surface} padding={2} {...props}><Stack gap={1} align="start">{body}</Stack></Card>
        : <Stack gap={1} align="start" {...props}>{body}</Stack>;
}

// 위치·바깥 클릭·Escape·중첩 레이어와 초점 복귀는 Astryx Popover가 소유한다.
export function ActionMenu({ label, trigger = "⋯", children, xstyle, ...props }: {
    label: string; trigger?: ReactNode; children: ReactNode; xstyle?: StackProps["xstyle"];
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
    const [open, setOpen] = useState(false);
    return <Stack direction="horizontal" gap={0} xstyle={xstyle} {...props}>
    <Popover label={label} isOpen={open} onOpenChange={setOpen} placement="below" alignment="end"
        width={240} padding={2} isModal={false}
        content={<Stack gap={1} role="group" aria-label={label} onClick={(event) => {
                const target = event.target as HTMLElement;
                const action = target.closest("button");
                // Astryx는 기본 submit 유형을 명시하므로 실제 폼 소속 여부로 구분한다.
                if (action && !action.hasAttribute("aria-haspopup") && !(action.type === "submit" && action.form)
                    && target.closest("dialog") === event.currentTarget.closest("dialog") && !event.defaultPrevented) setOpen(false);
            }}>
            {children}
        </Stack>}>
        <Button type="button" variant="secondary" appearance="menu" aria-label={label} title={label}>{trigger}</Button>
    </Popover>
    </Stack>;
}

export type DockTool = { id: string; label: string; icon?: "changes" | "file" | "terminal"; activity?: number; lazy?: boolean; content: ReactNode | ((close: () => void) => ReactNode) };

function subscribeCompact(notify: () => void) {
    const media = window.matchMedia("(max-width: 760px)");
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
}

type WorkbenchState = { open: boolean; toggle: () => void; activity: number };
const WorkbenchContext = createContext<WorkbenchState | null>(null);
export const PaneToolsTarget = createContext<HTMLElement | null | false>(null);

// 넓은 화면은 pane의 탭 줄, 좁은 화면은 본문 헤더에서 같은 패널을 연다.
export function ToolsTrigger({ inlineHeader = false }: { inlineHeader?: boolean }) {
    const state = useContext(WorkbenchContext);
    const target = useContext(PaneToolsTarget);
    if (!state || target === false) return null;
    const button = <Button type="button" variant="secondary" appearance="icon" xstyle={controlStyles.toolTrigger} aria-label="도구 패널" title="도구 패널"
        aria-expanded={state.open} onClick={state.toggle}>
        <Icon name="panel" />
        {state.activity > 0 && <Badge label={String(state.activity)} xstyle={controlStyles.toolActivity} aria-label={`진행 중 ${state.activity}개`} />}
    </Button>;
    if (target) return createPortal(button, target);
    return inlineHeader ? <Stack as="header" direction="horizontal" align="center" justify="end">{button}</Stack> : button;
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
    const opened = active !== null && visible;
    const activity = tools.reduce((sum, tool) => sum + (tool.activity ?? 0), 0);
    const close = () => setActive(null);
    const toggle = () => active ? close() : select(last.current ?? tools[0]!.id);
    return <WorkbenchContext.Provider value={{ open: !!active, toggle, activity }}>
    <Stack xstyle={chatLayout.workbench} data-ui="workbench">
        <Stack gap={3} xstyle={chatLayout.main} data-ui="workbench-main">{children}</Stack>
        <Drawer label={label} isOpen={opened} onOpenChange={(open) => { if (!open) close(); }}
            hasScrim={compact} width={compact ? "100%" : 480} padding={3}
            experimental={{ isFullWidthOnMobile: true }} data-testid="tool-dock">
            <Stack gap={3}>
            <Stack direction="horizontal" align="center" gap={1}>
                <TabList value={active ?? tools[0]!.id} onChange={select} role="tablist" aria-label={label} size={compact ? "lg" : "md"}>
                    {tools.map((tool) => <Tab key={tool.id} value={tool.id} id={`${id}-${tool.id}-tab`}
                        onFocus={() => select(tool.id)}
                        panelId={`${id}-${tool.id}`} label={tool.label}
                        icon={tool.icon && <Icon name={tool.icon} size={16} />}
                        endContent={!!tool.activity && <Badge label={String(tool.activity)} aria-label={`진행 중 ${tool.activity}개`} />} />)}
                </TabList>
                {active && <Button type="button" variant="secondary" appearance="icon" aria-label="도구 패널 닫기" onClick={close}><Icon name="close" size={16} /></Button>}
            </Stack>
            {tools.map((tool) => <Stack gap={0} key={tool.id} id={`${id}-${tool.id}`} role="tabpanel" aria-labelledby={`${id}-${tool.id}-tab`}
                hidden={active !== tool.id} maxWidth="100%">
                <PaneVisibility.Provider value={visible && active === tool.id}>
                    {(tool.lazy === false || visited.has(tool.id)) && (typeof tool.content === "function" ? tool.content(close) : tool.content)}
                </PaneVisibility.Provider>
            </Stack>)}
            </Stack>
        </Drawer>
    </Stack>
    </WorkbenchContext.Provider>;
}
