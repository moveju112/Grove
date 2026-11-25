import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Button as GroveButton } from "../../design/Button";
import { useEffect } from "react";
import { checkCompatibility, startLifecycle, useLifecycle } from "./lifecycle";
import { Banner } from "@astryxdesign/core/Banner";
import { noticeStyles } from "../../design/notices.stylex";

export function LifecycleBanner() {
    const state = useLifecycle();
    useEffect(startLifecycle, []);
    return (
        <GroveStack as="aside" gap={1} xstyle={noticeStyles.lifecycle} aria-label="PWA 상태" data-testid="pwa-lifecycle">
            {/* 연결 문제는 이 토스트 하나로만 알린다. 각 화면은 기존 값을 두고 연결이 돌아오면 다시 읽는다. */}
            {!state.online && <Banner status="info" role="status" data-testid="offline-banner" xstyle={noticeStyles.interactive}
                isDismissable dismissLabel="오프라인 알림 닫기"
                title="오프라인 · 연결되면 다시 불러옵니다" />}
            {state.online && state.connection === "unreachable" && <Banner status="error" role="alert" data-testid="connection-toast" xstyle={noticeStyles.interactive}
                isDismissable dismissLabel="연결 오류 닫기"
                title="서버에 연결할 수 없습니다"
                endContent={<GroveButton type="button" variant="secondary" density="compact" onClick={() => void checkCompatibility()}>연결 다시 확인</GroveButton>} />}
            {state.storageIssue && <Banner key={state.storageIssue} status="error" role="alert" data-testid="storage-warning" xstyle={noticeStyles.interactive}
                isDismissable dismissLabel="저장소 경고 닫기"
                title={state.storageIssue === "quota" ? "저장 공간 한도(quota)를 초과해 전송 확인 기록을 보관하지 못했어요. 기기 저장 공간을 확인하세요."
                    : state.storageIssue === "missing" ? "이 탭에서 확인했던 브라우저 저장 데이터가 없어졌어요. 이미 보낸 요청은 대화 기록에서 확인하세요."
                    : "기기 저장소에 접근할 수 없어 전송 확인 기록을 보관하지 못했어요. 브라우저 설정을 확인하세요."} />}
            {state.shell === "missing" && <Banner status="error" role="alert" data-testid="shell-warning" xstyle={noticeStyles.interactive}
                isDismissable dismissLabel="앱 캐시 경고 닫기"
                title="앱 cache가 삭제됐거나 자동 정리됐습니다. 현재 입력은 먼저 복사하세요. 오프라인 재실행은 보장되지 않으며, 온라인에서 새 UI를 확인하거나 다시 불러와야 합니다." />}
        </GroveStack>
    );
}
