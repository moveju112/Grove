import { useEffect, useState, useSyncExternalStore } from "react";
import { authGeneration, isLoggedIn, onAuthChange, rawGet } from "../api/client";

const subscribe = (notify: () => void) => onAuthChange(() => notify());

// 호출자가 소유한 URL만 사용하고 사진·인증 변경과 unmount에서 회수한다.
export function useBotAvatar(id: string | null, sha: string | null): string | null {
    const epoch = useSyncExternalStore(subscribe, authGeneration, () => 0);
    const key = `${epoch}:${id}:${sha}`;
    const [image, setImage] = useState<{ key: string; url: string } | null>(null);
    useEffect(() => {
        let active = true;
        let url: string | null = null;
        if (id && sha && isLoggedIn()) {
            void rawGet(`/bots/${id}/avatar`).then((bytes) => {
                if (!active || authGeneration() !== epoch || !isLoggedIn()) return;
                url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
                setImage({ key, url });
            }).catch(() => undefined);
        }
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [id, sha, epoch, key]);
    return image?.key === key ? image.url : null;
}
