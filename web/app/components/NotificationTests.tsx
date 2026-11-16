import { useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { PushNotificationTests } from "./PushNotificationTests";
import {
    NOTIFICATION_TESTS, runNotificationTest,
    type NotificationTestId, type NotificationTestResult,
} from "../state/notificationTests";

export function NotificationTests({ sound, vibrate }: { sound: boolean; vibrate: boolean }) {
    const [busy, setBusy] = useState<NotificationTestId | null>(null);
    const [results, setResults] = useState<Partial<Record<NotificationTestId, NotificationTestResult>>>({});
    const run = async (id: NotificationTestId) => {
        if (busy) return;
        setBusy(id);
        setResults((current) => ({ ...current, [id]: undefined }));
        try {
            const result = await runNotificationTest(id, { notifySound: sound, notifyVibrate: vibrate });
            setResults((current) => ({ ...current, [id]: result }));
        } finally { setBusy(null); }
    };
    return <Stack gap={3} role="group" aria-label="알림 시험" data-testid="notification-tests">
        <Text as="p" type="supporting" color="secondary">1~5번은 위 설정과 별개로 시험해. 시스템 알림은 상단 알림창도 확인해줘.</Text>
        {NOTIFICATION_TESTS.map(({ id, label }) => <Stack key={id} gap={1}>
            <Button type="button" variant="secondary" density="compact" width="100%" disabled={busy !== null}
                aria-busy={busy === id} onClick={() => void run(id)}>{label}</Button>
            {results[id] && <Text as="p" type="supporting" role="status"
                color={results[id].status === "requested" ? "secondary" : "warning"}
                data-testid={`notification-test-result-${id}`}>{results[id].message}</Text>}
        </Stack>)}
        <PushNotificationTests />
    </Stack>;
}
