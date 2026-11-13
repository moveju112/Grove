import { useState } from "react";
import { safeAssistantImageUrl } from "./imagePolicy";
import styles from "./AssistantIdentity.module.css";

export type AssistantIdentityProps = {
    name: string;
    /** 인증된 PNG 응답으로 호출자가 만든 same-origin object URL. 소유·폐기도 호출자 책임이다. */
    imageUrl?: string | null;
    size?: "sm" | "md" | "lg";
    /** label: 이름과 장식 이미지, avatar: 이름 있는 이미지, decorative: 보조기술에서 전체 제외. */
    purpose?: "label" | "avatar" | "decorative";
};

function DefaultIcon() {
    return <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-testid="assistant-default-icon">
        <path d="M12 3v3M9 3h6" />
        <rect x="4" y="6" width="16" height="14" rx="4" />
        <path d="M8 15h8M2 10v6M22 10v6" />
        <circle cx="8.5" cy="11" r=".8" fill="currentColor" stroke="none" />
        <circle cx="15.5" cy="11" r=".8" fill="currentColor" stroke="none" />
    </svg>;
}

function Avatar({ src }: { src: string | null }) {
    const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
    const ready = src !== null && state === "ready";
    return <span className={styles.avatar} aria-hidden="true" data-image-state={src ? state : "fallback"}>
        {!ready && <DefaultIcon />}
        {src && state !== "failed" && <img
            className={`${styles.image}${ready ? "" : ` ${styles.pending}`}`}
            src={src} alt="" aria-hidden="true" draggable={false} referrerPolicy="no-referrer"
            onLoad={() => setState("ready")} onError={() => setState("failed")}
        />}
    </span>;
}

/** API 호출·설정 저장 없이 전달받은 identity만 표시한다. */
export function AssistantIdentity({ name, imageUrl, size = "md", purpose = "label" }: AssistantIdentityProps) {
    const displayName = name.trim() || "어시스턴트";
    const src = safeAssistantImageUrl(imageUrl, typeof window === "undefined" ? "" : window.location.origin);
    return <span
        className={styles.identity}
        data-size={size}
        data-purpose={purpose}
        data-testid="assistant-identity"
        role={purpose === "avatar" ? "img" : undefined}
        aria-label={purpose === "avatar" ? displayName : undefined}
        aria-hidden={purpose === "decorative" ? true : undefined}
    >
        {/* URL 교체 때만 상태를 초기화한다. 실패한 URL은 rerender로 재시도하지 않는다. */}
        <Avatar key={src ?? "default"} src={src} />
        {purpose === "label" && <span className={styles.name} dir="auto" data-testid="assistant-name">{displayName}</span>}
    </span>;
}
