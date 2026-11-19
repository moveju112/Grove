import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { Button } from "../design/Button";
import type { FollowKind } from "../state/sendOptions";
import { Icon } from "./icons";

const styles = stylex.create({
    trigger: { display: "grid", width: 36 },
    disabledTrigger: { pointerEvents: "none" },
});

export const FOLLOW_LABEL: Record<FollowKind, string> = { queue: "대기열", steer: "합치기", interrupt: "중단 후 전송" };

export function SendButton({ label, title, disabled, follow, steerHint, describedBy, onSend }: {
    label: string;
    title: string;
    disabled: boolean;
    follow?: FollowKind;
    steerHint?: string;
    describedBy?: string;
    onSend: (follow?: FollowKind) => void;
}) {
    const [open, setOpen] = useState(false);
    const suppressClick = useRef(false);
    const available = follow !== undefined && !disabled;
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
            description: kind === "steer" ? steerHint : undefined,
            onClick: () => {
                if (!available || kind === follow) return;
                setOpen(false);
                onSend(kind);
            },
        }))}
        renderTrigger={(props) => <div {...stylex.props(styles.trigger)} title={disabled ? title : undefined}
            onContextMenuCapture={(event) => {
                event.preventDefault();
                if (!available) return;
                suppressClick.current = true;
                setOpen(true);
            }}>
            <Button ref={props.ref} id={props.id} type="button"
                appearance="send" width="100%" aria-label={label} title={disabled ? undefined : title} disabled={disabled}
                xstyle={disabled && styles.disabledTrigger}
                aria-describedby={describedBy}
                aria-haspopup={available ? "menu" : undefined}
                aria-expanded={available ? open : undefined}
                aria-controls={available ? props["aria-controls"] : undefined}
                onClickCapture={props.onClickCapture}
                onPointerDown={(event) => {
                    suppressClick.current = false;
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
