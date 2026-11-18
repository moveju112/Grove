import { useEffect, useRef, useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { CreationDialog } from "./create/CreationDialog";
import { Icon } from "./icons";

export type MobileNotificationPlatform = "android" | "ios";

export function mobileNotificationPlatform(userAgent: string, maxTouchPoints: number): MobileNotificationPlatform | null {
    if (/Android/i.test(userAgent)) return "android";
    if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "ios";
    return null;
}

export const APP_NOTIFICATION_STEPS: Record<MobileNotificationPlatform, readonly string[]> = {
    android: [
        "휴대폰 설정에서 애플리케이션을 열어.",
        "Grove를 선택하고 알림의 ‘알림 허용’을 켜.",
        "소리·진동·팝업도 같은 알림 화면에서 확인해.",
    ],
    ios: [
        "iPhone·iPad 설정에서 알림을 열어.",
        "홈 화면에 추가한 Grove를 선택하고 ‘알림 허용’을 켜.",
        "사운드와 잠금 화면·알림 센터·배너도 같은 화면에서 확인해.",
    ],
};

export function AppNotificationPermission({ request }: { request: number }) {
    const [platform, setPlatform] = useState<MobileNotificationPlatform | null>(null);
    const [open, setOpen] = useState(false);
    const automaticallyShown = useRef(false);
    useEffect(() => {
        setPlatform(mobileNotificationPlatform(navigator.userAgent, navigator.maxTouchPoints));
    }, []);
    useEffect(() => {
        if (platform && request > 0 && !automaticallyShown.current) {
            automaticallyShown.current = true;
            setOpen(true);
        }
    }, [platform, request]);
    if (!platform) return null;
    return <Stack gap={1} data-testid="app-notification-permission">
        <Text as="p" type="supporting" color="secondary">브라우저에서 허용해도 설치한 Grove 앱의 알림 권한은 별도로 켜야 할 수 있어.</Text>
        <Button type="button" variant="secondary" density="compact" onClick={() => setOpen(true)}>앱 알림 권한 켜는 방법</Button>
        {open && <CreationDialog label="휴대폰 앱 알림 권한" onClose={() => setOpen(false)}>
            <Stack direction="horizontal" align="center" justify="between" gap={2}>
                <Heading level={2}>Grove 앱 알림 권한</Heading>
                <Button type="button" appearance="icon" aria-label="앱 알림 권한 안내 닫기" onClick={() => setOpen(false)}><Icon name="close" /></Button>
            </Stack>
            <Text as="p">브라우저의 ‘허용됨’은 휴대폰의 앱 알림 권한까지 확인한 결과는 아니야.</Text>
            <List listStyle="decimal">
                {APP_NOTIFICATION_STEPS[platform].map((step) => <ListItem key={step} label={step} />)}
            </List>
            <Text as="p" type="supporting" color="secondary">{platform === "android"
                ? "Grove가 앱 목록에 없다면 현재 사용하는 브라우저의 앱 알림과 사이트별 알림 항목을 확인해."
                : "Grove 항목이 없다면 먼저 홈 화면에 추가한 Grove 앱에서 알림을 켜줘."}</Text>
            <Text as="p" type="supporting" color="secondary">이 웹앱에서는 휴대폰 설정 화면을 직접 열거나 앱 권한 상태를 읽을 수 없어. 변경은 휴대폰 설정에서 해줘.</Text>
        </CreationDialog>}
    </Stack>;
}
