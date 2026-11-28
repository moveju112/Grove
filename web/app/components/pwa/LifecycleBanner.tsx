import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Button as GroveButton } from "../../design/Button";
import { useEffect } from "react";
import { checkCompatibility, startLifecycle, useLifecycle } from "./lifecycle";
import { Banner } from "@astryxdesign/core/Banner";
import { noticeStyles } from "../../design/notices.stylex";
import { ErrorNotice } from "../../design/TimedNotice";

export function LifecycleBanner() {
    const state = useLifecycle();
    useEffect(startLifecycle, []);
    return (
        <GroveStack as="aside" gap={1} xstyle={noticeStyles.lifecycle} aria-label="PWA 상태" data-testid="pwa-lifecycle">
            {/* 연결 문제는 이 토스트 하나로만 알린다. 각 화면은 기존 값을 두고 연결이 돌아오면 다시 읽는다. */}
            {!state.online && <Banner status="info" role="status" data-testid="offline-banner" xstyle={noticeStyles.interactive}
                isDismissable dismissLabel="오프라인 알림 닫기"
                title="오프라인 · 연결되면 다시 불러옵니다" />}
            {state.online && state.connection === "unreachable" && <ErrorNotice data-testid="connection-toast"
                isDismissable dismissLabel="연결 오류 닫기"
                title="서버에 연결할 수 없습니다"
                endContent={<GroveButton type="button" variant="secondary" density="compact" onClick={() => void checkCompatibility()}>연결 다시 확인</GroveButton>} />}
            {state.storageIssue && <ErrorNotice key={state.storageIssue} data-testid="storage-warning"
                isDismissable dismissLabel="저장소 경고 닫기"
                title={state.storageIssue === "quota" ? "저장 공간 한도(quota)를 초과해 전송 확인 기록을 보관하지 못했어요. 기기 저장 공간을 확인하세요."
                    : state.storageIssue === "missing" ? "이 탭에서 확인했던 브라우저 저장 데이터가 없어졌어요. 이미 보낸 요청은 대화 기록에서 확인하세요."
                    : "기기 저장소에 접근할 수 없어 전송 확인 기록을 보관하지 못했어요. 브라우저 설정을 확인하세요."} />}
        </GroveStack>
    );
}
