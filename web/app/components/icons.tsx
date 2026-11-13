// 선 아이콘 한 세트(lucide 계열, 24 격자·선 굵기 1.5). 장식용이라 보조기술에서는 숨기고, 이름은 감싼 버튼이 가진다.
const PATHS = {
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
