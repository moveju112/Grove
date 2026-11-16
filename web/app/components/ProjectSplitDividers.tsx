import { Divider } from "@astryxdesign/core/Divider";
import { useRef, type RefObject } from "react";
import * as L from "../state/layout";
import { projectGeometry, type ProjectDivider } from "../state/projectSplits";
import { splitStyles } from "./split-layout.stylex";

export function ProjectSplitDividers({ layout, container, update }: {
    layout: L.Layout; container: RefObject<HTMLDivElement | null>; update: (f: (layout: L.Layout) => L.Layout) => void;
}) {
    const dragging = useRef<ProjectDivider | null>(null);
    return projectGeometry(layout).dividers.map((divider) => {
        const { rect, direction, ratio, path } = divider;
        const row = direction === "row";
        return <Divider key={path.join(".")} role="separator" aria-label="프로젝트 영역 크기 조절"
            orientation={row ? "vertical" : "horizontal"} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
            data-testid="project-divider" data-direction={direction}
            xstyle={[splitStyles.divider, row ? splitStyles.horizontal : splitStyles.vertical,
                splitStyles.projectDivider(`${(rect.x + (row ? rect.width * ratio : 0)) * 100}%`,
                    `${(rect.y + (row ? 0 : rect.height * ratio)) * 100}%`, row ? "6px" : `${rect.width * 100}%`,
                    row ? `${rect.height * 100}%` : "6px", row)]}
            onPointerDown={(event) => {
                dragging.current = divider;
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                const drag = dragging.current, bounds = container.current?.getBoundingClientRect();
                if (!drag || !bounds) return;
                const next = drag.direction === "row"
                    ? (event.clientX - bounds.left - bounds.width * drag.rect.x) / (bounds.width * drag.rect.width)
                    : (event.clientY - bounds.top - bounds.height * drag.rect.y) / (bounds.height * drag.rect.height);
                update((current) => L.setRatio(current, drag.path, next));
            }}
            onPointerUp={() => { dragging.current = null; }}
            onPointerCancel={() => { dragging.current = null; }}
            onKeyDown={(event) => {
                const delta = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.05 : ["ArrowRight", "ArrowDown"].includes(event.key) ? 0.05 : 0;
                if (!delta) return;
                event.preventDefault();
                update((current) => L.setRatio(current, path, ratio + delta));
            }}
            onDoubleClick={() => update((current) => L.setDirection(current, path, row ? "column" : "row"))} />;
    });
}
