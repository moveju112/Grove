import { Icon as AstryxIcon, type IconColor, type IconType } from "@astryxdesign/core/Icon";
import type { SVGProps } from "react";

// 앱 고유 도형은 Astryx Icon의 component mode로 렌더링한다. 새싹 도형은 브랜드 계약이다.
const PATHS = {
    usage: <><path d="M4 3v17h17M8 16v-4M13 16V8M18 16V5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    warning: <><path d="M10.3 4.9 2.9 18a2 2 0 0 0 1.8 3h14.6a2 2 0 0 0 1.8-3L13.7 4.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3M12 17h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.6l6.2-.9Z" />,
    starFilled: <path fill="currentColor" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.6l6.2-.9Z" />,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    send: <path d="M12 20V4m-7 7 7-7 7 7" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="1" />,
    fast: <path d="m13 2-9 12h7l-1 8 10-12h-7z" fill="currentColor" stroke="none" />,
    expand: <><path d="M14 3h7v7M21 3l-9 9M10 21H3v-7" /></>,
    maximize: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />,
    minimize: <path d="M9 3v6H3m12-6v6h6M3 15h6v6m12-6h-6v6" />,
    changes: <><path d="M4 7h16M4 17h16M9 3v8M15 13v8" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
    terminal: <><path d="m4 6 6 6-6 6M13 18h7" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-3 2v-5.2A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" /><path d="M9 11.5h6" /></>,
    keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></>,
    attachment: <path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.5 5.5L10 16.5a2 2 0 0 1-3-3L15 5" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    sidebar: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18" /></>,
    panel: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M15 3v18" /></>,
    panelBottom: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 15h18" /></>,
    pin: <><path d="m16 3 5 5-4 1-4 4v4l-2 2-6-6 2-2h4l4-4zM2 22l6-6" /></>,
    eyeOff: <><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.9 10.9 0 0 1 12 5c6 0 10 7 10 7a19.7 19.7 0 0 1-3.2 3.8M6.2 6.2A20 20 0 0 0 2 12s4 7 10 7a11 11 0 0 0 5.8-1.8" /></>,
    restore: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.4 3.6a2 2 0 0 1 2.9 2.9L7 18.8 3 20l1.2-4z" /></>,
    settings: <><path d="M9.13 5.07L10.44 4.66L10.44 2.12L13.56 2.12L13.56 4.66L14.87 5.07L16.08 5.71L17.88 3.91L20.09 6.12L18.29 7.92L18.93 9.13L19.34 10.44L21.88 10.44L21.88 13.56L19.34 13.56L18.93 14.87L18.29 16.08L20.09 17.88L17.88 20.09L16.08 18.29L14.87 18.93L13.56 19.34L13.56 21.88L10.44 21.88L10.44 19.34L9.13 18.93L7.92 18.29L6.12 20.09L3.91 17.88L5.71 16.08L5.07 14.87L4.66 13.56L2.12 13.56L2.12 10.44L4.66 10.44L5.07 9.13L5.71 7.92L3.91 6.12L6.12 3.91L7.92 5.71Z" /><circle cx="12" cy="12" r="3" /></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    link: <><path d="m10 13 4-4M8 16l-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0M13 17a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-1 1" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    chevronRight: <path d="m9 5 7 7-7 7" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    sprout: <><path d="M12 21v-9" /><path d="M12 12c0-3.3 2.4-6 6-6 0 3.3-2.4 6-6 6Z" /><path d="M12 14c0-3-2.2-5.5-5.5-5.5 0 3 2.2 5.5 5.5 5.5Z" /></>,
    assistant: <><path d="M12 3v3M9 3h6" /><rect x="4" y="6" width="16" height="14" rx="4" />
        <path d="M8 15h8M2 10v6M22 10v6" /><circle cx="8.5" cy="11" r=".8" fill="currentColor" stroke="none" />
        <circle cx="15.5" cy="11" r=".8" fill="currentColor" stroke="none" /></>,
} as const;

export type IconName = keyof typeof PATHS;

function glyph(name: IconName): IconType {
    return function Glyph(props: SVGProps<SVGSVGElement>) {
        return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "assistant" ? 1.6 : 1.5}
            strokeLinecap="round" strokeLinejoin="round" {...props}>{PATHS[name]}</svg>;
    };
}

const GLYPHS = Object.fromEntries((Object.keys(PATHS) as IconName[]).map((name) => [name, glyph(name)])) as Record<IconName, IconType>;

export function Icon({ name, size = 18, color = "inherit", ...props }: {
    name: IconName; size?: number | string; color?: IconColor; "data-testid"?: string;
}) {
    const tier = typeof size !== "number" ? "md" : size <= 12 ? "xsm" : size <= 16 ? "sm" : size <= 20 ? "md" : "lg";
    return <AstryxIcon {...props} icon={GLYPHS[name]} size={tier} color={color} focusable="false" />;
}
