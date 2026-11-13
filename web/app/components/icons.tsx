// 선 아이콘 한 세트(lucide 계열, 24 격자·선 굵기 1.5). 장식용이라 보조기술에서는 숨기고, 이름은 감싼 버튼이 가진다.
const PATHS = {
    close: <path d="m6 6 12 12M6 18 18 6" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3M12 17h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    send: <path d="M12 20V4m-7 7 7-7 7 7" />,
    expand: <><path d="M14 3h7v7M21 3l-9 9M10 21H3v-7" /></>,
    changes: <><path d="M4 7h16M4 17h16M9 3v8M15 13v8" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
    terminal: <><path d="m4 6 6 6-6 6M13 18h7" /></>,
    attachment: <path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.5 5.5L10 16.5a2 2 0 0 1-3-3L15 5" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    sidebar: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.4 3.6a2 2 0 0 1 2.9 2.9L7 18.8 3 20l1.2-4z" /></>,
    settings: <><path d="M20 7h-9M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
    sprout: <><path d="M12 21v-9" /><path d="M12 12c0-3.3 2.4-6 6-6 0 3.3-2.4 6-6 6Z" /><path d="M12 14c0-3-2.2-5.5-5.5-5.5 0 3 2.2 5.5 5.5 5.5Z" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
    return (
        <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            {PATHS[name]}
        </svg>
    );
}
