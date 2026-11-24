import * as stylex from "@stylexjs/stylex";
import { rawGet } from "../api/client";
import type { Project } from "../api/generated";
import { base64 } from "../api/transport";
import { useQuery } from "../state/store";

export const iconPalette = [
    { name: "남색", ink: "#50589d", background: "#e7e9fa" },
    { name: "청록", ink: "#226b6e", background: "#d9eeec" },
    { name: "주황", ink: "#874628", background: "#f8e7da" },
    { name: "분홍", ink: "#88465c", background: "#f5e4eb" },
    { name: "보라", ink: "#704c86", background: "#eee5f5" },
    { name: "회색", ink: "#4e5c6a", background: "#e4e9ee" },
] as const;

export function defaultIconColor(id: string) {
    let hash = 0;
    for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    return hash % iconPalette.length;
}

const styles = stylex.create({
    tile: {
        display: "inline-grid", placeItems: "center", flexShrink: 0, overflow: "hidden",
        borderRadius: 3, fontWeight: 650, lineHeight: 1, userSelect: "none",
    },
    dimensions: (size: number, font: number) => ({ width: size, height: size, fontSize: font }),
    tint: (ink: string, background: string) => ({ color: ink, backgroundColor: background }),
    image: { width: "100%", height: "100%", objectFit: "cover" },
});

type Identity = Pick<Project, "id" | "name" | "icon" | "icon_color" | "icon_photo_sha256">;
const initialSegment = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;

export function ProjectIcon({ project, size = 16, draftPhoto }: {
    project: Identity; size?: 12 | 16 | 48; draftPhoto?: string | null;
}) {
    const { id, name, icon, icon_color, icon_photo_sha256: sha } = project;
    const image = useQuery(draftPhoto === undefined && sha ? `project-icon:${id}:${sha}` : null, async () => {
        const bytes = await rawGet(`/projects/${id}/icon/${sha}`);
        return `data:image/png;base64,${base64(new Uint8Array(bytes))}`;
    });
    const src = draftPhoto === undefined ? image.data : draftPhoto;
    const tint = iconPalette[icon_color ?? defaultIconColor(id)] ?? iconPalette[0];
    const title = name.trim();
    const initial = initialSegment?.segment(title).containing(0)?.segment ?? [...title][0] ?? "?";
    return <span aria-hidden="true" data-testid="project-icon" {...stylex.props(styles.tile,
        styles.dimensions(size, Math.round(size * 0.7)), styles.tint(tint.ink, tint.background))}>
        {src ? <img alt="" draggable={false} src={src} {...stylex.props(styles.image)} /> : (icon || initial)}
    </span>;
}
