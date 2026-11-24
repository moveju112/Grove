import { useEffect, useRef } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../design/Button";
import { contentStyles } from "../design/content.stylex";
import type { Attachment } from "../state/sendRecovery";
import { attachmentStyles as styles } from "./attachments.stylex";
import { CreationDialog } from "./create/CreationDialog";
import { Icon } from "./icons";

export type PreviewSource = { url: string | null; error: string | null; retry?: () => void };
type Gallery = { images: Attachment[]; sources: Record<string, PreviewSource>; index: number; select: (id: string) => void };

export function ImagePreviewDialog({ name, source, onClose, onDownload, gallery }: {
    name: string; source?: PreviewSource; onClose: () => void; onDownload?: () => void; gallery?: Gallery;
}) {
    const activeThumb = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        activeThumb.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [gallery?.index]);
    const move = (delta: number) => {
        if (!gallery) return;
        const { images, index, select } = gallery;
        select(images[(index + delta + images.length) % images.length]!.id);
    };
    return <CreationDialog label={`${name} 미리보기`} width="min(56em, 100%)" onClose={onClose}>
        <Stack gap={2} onKeyDown={(event) => {
            if (!gallery || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            move(event.key === "ArrowLeft" ? -1 : 1);
        }}>
            <Stack direction="horizontal" justify="end" align="center" gap={1}>
                {gallery && <Text role="status" type="supporting" color="secondary" xstyle={styles.counter}>{gallery.index + 1} / {gallery.images.length}</Text>}
                {onDownload && <Button type="button" variant="secondary" density="compact" onClick={onDownload}>원문 다운로드</Button>}
                <Button type="button" appearance="icon" aria-label="미리보기 닫기" onClick={onClose}><Icon name="close" /></Button>
            </Stack>
            <Stack align="center" justify="center" xstyle={gallery && styles.stage}>
                {source?.url && !source.error
                    ? <img {...stylex.props(contentStyles.previewImage, gallery && styles.galleryImage)} src={source.url} alt={name} />
                    : source?.error ? <><Text color="error" role="alert">{source.error}</Text>
                        {source.retry && <Button type="button" onClick={source.retry}>다시 불러오기</Button>}</>
                        : <Text role="status">이미지를 불러오는 중…</Text>}
                {gallery && <>
                    <Button type="button" appearance="icon" width={44} aria-label="이전 사진" xstyle={[styles.arrow, styles.left]}
                        onClick={() => move(-1)}><Icon name="chevronLeft" size={20} /></Button>
                    <Button type="button" appearance="icon" width={44} aria-label="다음 사진" xstyle={[styles.arrow, styles.right]}
                        onClick={() => move(1)}><Icon name="chevronRight" size={20} /></Button>
                </>}
            </Stack>
            {gallery && <Stack direction="horizontal" gap={2} role="group" aria-label="사진 선택" data-swipe-blocked xstyle={[styles.strip, styles.filmstrip]}>
                {gallery.images.map((image, i) => {
                    const thumbnail = gallery.sources[image.id];
                    const active = i === gallery.index;
                    return <Button key={image.id} ref={active ? activeThumb : undefined} type="button" variant="secondary" width={56}
                        aria-label={`${i + 1}번째 사진, ${image.name}`} aria-current={active || undefined}
                        xstyle={[styles.galleryThumb, active && styles.current]} onClick={() => gallery.select(image.id)}>
                        {thumbnail?.url && !thumbnail.error ? <img {...stylex.props(styles.thumbImage)} src={thumbnail.url} alt="" />
                            : <Icon name="file" />}
                    </Button>;
                })}
            </Stack>}
        </Stack>
    </CreationDialog>;
}
