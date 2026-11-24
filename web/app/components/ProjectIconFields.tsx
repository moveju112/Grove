import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Project } from "../api/generated";
import { Button } from "../design/Button";
import { FileInput } from "../design/Fields";
import { ProjectIcon, defaultIconColor, iconPalette } from "./ProjectIcon";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
    swatch: (color: string) => ({ backgroundColor: color, color: "white", borderRadius: "50%",
        width: 22, height: 22, display: "inline-grid", placeItems: "center", fontWeight: 700 }),
});

export type IconDraft = { icon_color?: number | null; icon_photo_base64?: string | null; icon?: null };

async function thumbnail(file: File) {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))
        throw new Error("PNG, JPEG, WebP, GIF 사진을 선택해 주세요.");
    if (file.size > 32 * 1024 * 1024) throw new Error("32MiB 이하의 사진을 선택해 주세요.");
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(96, side);
        const context = canvas.getContext("2d");
        if (!context || !side) throw new Error();
        context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
            side, side, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png").split(",")[1]!;
    } catch {
        throw new Error("사진을 읽지 못했어요. 다른 사진을 선택해 주세요.");
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function ProjectIconFields({ project, draft, onChange, disabled, onReading, onError }: {
    project: Project; draft: IconDraft; onChange: (draft: IconDraft) => void; disabled: boolean;
    onReading: (busy: boolean) => void; onError: (error: string | null) => void;
}) {
    const color = draft.icon_color === undefined ? project.icon_color : draft.icon_color;
    const chosen = color ?? defaultIconColor(project.id);
    const hasPhoto = draft.icon_photo_base64 === undefined ? !!project.icon_photo_sha256 : !!draft.icon_photo_base64;
    const select = async (file: File) => {
        onError(null);
        onReading(true);
        try { onChange({ ...draft, icon_photo_base64: await thumbnail(file) }); }
        catch (error) { onError(error instanceof Error ? error.message : "사진을 읽지 못했어요."); }
        finally { onReading(false); }
    };
    return <Stack gap={3}>
        <Stack direction="horizontal" align="center" gap={3}>
            <ProjectIcon project={{ ...project, icon_color: chosen, icon: draft.icon === null ? null : project.icon }}
                size={48} draftPhoto={draft.icon_photo_base64 ? `data:image/png;base64,${draft.icon_photo_base64}` : draft.icon_photo_base64} />
            <Text weight="semibold" maxLines={1}>{project.name}</Text>
        </Stack>
        <Stack gap={1} role="group" aria-label="아이콘 색상">
            <Text type="supporting">아이콘 색상</Text>
            <Stack direction="horizontal" gap={1} wrap="wrap">
                {iconPalette.map((tint, i) => <Button key={tint.name} type="button" appearance="icon" disabled={disabled}
                    aria-label={tint.name} aria-pressed={!hasPhoto && chosen === i}
                    onClick={() => onChange({ ...draft, icon_color: i, icon_photo_base64: null })}>
                    <span aria-hidden="true" {...stylex.props(styles.swatch(tint.ink))}>{!hasPhoto && chosen === i ? "✓" : ""}</span>
                </Button>)}
            </Stack>
        </Stack>
        <FileInput label="사진 업로드" value={null} isDisabled={disabled} accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(files) => { const file = Array.isArray(files) ? files[0] : files; if (file) void select(file); }} />
        {(hasPhoto || color != null || (draft.icon !== null && project.icon)) && <Button type="button" appearance="link" disabled={disabled}
            onClick={() => onChange({ icon_color: null, icon_photo_base64: null, icon: null })}>기본 아이콘으로</Button>}
    </Stack>;
}
