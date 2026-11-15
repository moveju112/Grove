import { Icon as AstryxIcon, type IconType } from "@astryxdesign/core/Icon";
import type { SVGProps } from "react";

// 앱 고유 도형은 Astryx Icon의 component mode로 렌더링한다. 새싹 도형은 브랜드 계약이다.
const PATHS = {
    close: <path d="m6 6 12 12M6 18 18 6" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3M12 17h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    send: <path d="M12 20V4m-7 7 7-7 7 7" />,
    fast: <path d="m13 2-9 12h7l-1 8 10-12h-7z" />,
    expand: <><path d="M14 3h7v7M21 3l-9 9M10 21H3v-7" /></>,
    changes: <><path d="M4 7h16M4 17h16M9 3v8M15 13v8" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
    terminal: <><path d="m4 6 6 6-6 6M13 18h7" /></>,
    attachment: <path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.5 5.5L10 16.5a2 2 0 0 1-3-3L15 5" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    sidebar: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18" /></>,
    panel: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M15 3v18" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.4 3.6a2 2 0 0 1 2.9 2.9L7 18.8 3 20l1.2-4z" /></>,
    settings: <><path d="M20 7h-9M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    link: <><path d="m10 13 4-4M8 16l-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0M13 17a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-1 1" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    chevronRight: <path d="m9 5 7 7-7 7" />,
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

export function Icon({ name, size = 18, className = "", ...props }: {
    name: IconName; size?: number | string; className?: string; "data-testid"?: string;
}) {
    return <AstryxIcon {...props} icon={GLYPHS[name]} className={`icon ${className}`} color="inherit"
        style={{ width: size, height: size }} focusable="false" />;
}
