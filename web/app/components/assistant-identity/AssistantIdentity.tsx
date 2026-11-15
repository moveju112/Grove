import { Text as GroveText } from "@astryxdesign/core/Text";
import { useState } from "react";
import { Icon } from "../icons";
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
    return <Icon name="assistant" size="75%" className={styles.icon} data-testid="assistant-default-icon" />;
}

function Avatar({ src }: { src: string | null }) {
    const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
    const ready = src !== null && state === "ready";
    return <GroveText type="inherit" color="inherit" className={styles.avatar} aria-hidden="true" data-image-state={src ? state : "fallback"}>
        {!ready && <DefaultIcon />}
        {src && state !== "failed" && <img
            className={`${styles.image}${ready ? "" : ` ${styles.pending}`}`}
            src={src} alt="" aria-hidden="true" draggable={false} referrerPolicy="no-referrer"
            onLoad={() => setState("ready")} onError={() => setState("failed")}
        />}
    </GroveText>;
}

/** API 호출·설정 저장 없이 전달받은 identity만 표시한다. */
export function AssistantIdentity({ name, imageUrl, size = "md", purpose = "label" }: AssistantIdentityProps) {
    const displayName = name.trim() || "어시스턴트";
    const src = safeAssistantImageUrl(imageUrl, typeof window === "undefined" ? "" : window.location.origin);
    return <GroveText type="inherit" color="inherit"
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
        {purpose === "label" && <GroveText type="inherit" color="inherit" className={styles.name} dir="auto" data-testid="assistant-name">{displayName}</GroveText>}
    </GroveText>;
}
