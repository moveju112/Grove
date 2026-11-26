import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { Button } from "../design/Button";
import type { FollowKind } from "../state/sendOptions";
import { Icon } from "./icons";

const styles = stylex.create({
    trigger: { display: "grid", width: 36, WebkitTouchCallout: "none", userSelect: "none" },
    disabledTrigger: { pointerEvents: "none" },
});

export const FOLLOW_LABEL: Record<FollowKind, string> = { queue: "대기열", steer: "합치기", interrupt: "중단 후 전송" };

export function SendButton({ label, title, disabled, follow, onSend }: {
    label: string;
    title: string;
    disabled: boolean;
    follow?: FollowKind;
    onSend: (follow?: FollowKind) => void;
}) {
    const [open, setOpen] = useState(false);
    const suppressClick = useRef(false);
    const rightPress = useRef<"down" | "context" | null>(null);
    const available = follow !== undefined && !disabled;
    const openMenu = () => {
        if (!available) return;
        suppressClick.current = true;
        setOpen(true);
    };
    useEffect(() => {
        if (!available) setOpen(false);
    }, [available]);

    return <DropdownMenu placement="above" alignment="end" presentation="popover"
        isMenuOpen={available && open} onOpenChange={(value) => {
            if (available && value) suppressClick.current = true;
            setOpen(available && value);
        }}
        items={(Object.keys(FOLLOW_LABEL) as FollowKind[]).map((kind) => ({
            id: kind, label: FOLLOW_LABEL[kind], isDisabled: !available || kind === follow,
            onClick: () => {
                if (!available || kind === follow) return;
                setOpen(false);
                onSend(kind);
            },
        }))}
        renderTrigger={(props) => <div {...stylex.props(styles.trigger)} title={disabled ? title : undefined}
            data-swipe-blocked
            onPointerDown={(event) => {
                rightPress.current = event.pointerType === "mouse" && event.button === 2 ? "down" : null;
                suppressClick.current = false;
            }}
            onPointerUp={(event) => {
                if (event.button === 2 && rightPress.current === "context") openMenu();
                rightPress.current = null;
            }}
            onPointerLeave={() => { rightPress.current = null; }}
            onPointerCancel={() => { rightPress.current = null; }}
            onContextMenuCapture={(event) => {
                event.preventDefault();
                if (!available) return;
                // 터치는 메뉴의 길게 누르기 처리에만 맡겨, 같은 제스처가 메뉴를 두 번 열지 않게 한다.
                if ((event.nativeEvent as PointerEvent).pointerType === "touch") return;
                // 누르는 순간 contextmenu가 오는 브라우저는 우클릭을 놓은 뒤 연다.
                // 여는 데 쓴 pointerup이 팝오버를 곧바로 닫지 않아야 한다.
                if (event.button === 2 && rightPress.current !== null) rightPress.current = "context";
                else openMenu();
            }}>
            <Button ref={props.ref} id={props.id} type="button"
                appearance="send" width="100%" aria-label={label} title={disabled ? undefined : title} disabled={disabled}
                xstyle={disabled && styles.disabledTrigger}
                aria-haspopup={available ? "menu" : undefined}
                aria-expanded={available ? open : undefined}
                aria-controls={available ? props["aria-controls"] : undefined}
                onClickCapture={props.onClickCapture}
                onPointerDown={(event) => {
                    if (available && event.pointerType !== "mouse") props.onPointerDown(event);
                }}
                onKeyDown={(event) => {
                    if (!available) return;
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                        event.preventDefault();
                        setOpen(true);
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Escape") {
                        props.onKeyDown(event);
                    }
                }}
                onClick={(event) => {
                    if (suppressClick.current && event.detail !== 0) {
                        event.preventDefault();
                        return;
                    }
                    onSend();
                }}>
                <Icon name="send" />
            </Button>
        </div>} />;
}
