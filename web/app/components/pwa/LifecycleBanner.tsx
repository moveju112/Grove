import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useEffect } from "react";
import { checkCompatibility, startLifecycle, useLifecycle } from "./lifecycle";
import "./pwa.css";

export function LifecycleBanner() {
    const state = useLifecycle();
    useEffect(startLifecycle, []);
    return (
        <aside className="pwa-lifecycle" aria-label="PWA 상태" data-testid="pwa-lifecycle">
            {/* 연결 문제는 이 토스트 하나로만 알린다. 각 화면은 기존 값을 두고 연결이 돌아오면 다시 읽는다. */}
            {!state.online && <div className="connection-toast" role="status" data-testid="offline-banner">
                <span className="connection-toast-dot" aria-hidden="true" />
                <GroveText type="inherit" color="inherit">오프라인 · 연결되면 다시 불러옵니다</GroveText>
            </div>}
            {state.online && state.connection === "unreachable" && <div className="connection-toast error" role="alert" data-testid="connection-toast">
                <span className="connection-toast-dot" aria-hidden="true" />
                <GroveText type="inherit" color="inherit">서버에 연결할 수 없습니다</GroveText>
                <GroveButton type="button" className="ghost small" onClick={() => void checkCompatibility()}>연결 다시 확인</GroveButton>
            </div>}
            {state.storageIssue && <div className="update-banner error" role="alert" data-testid="storage-warning">
                {state.storageIssue === "quota" ? "저장 공간 한도(quota)를 초과해 기기 초안 저장에 실패했습니다. 화면을 떠나거나 업데이트하기 전에 입력을 복사하세요."
                    : state.storageIssue === "missing" ? "이 탭에서 확인했던 브라우저 저장 데이터가 없어졌습니다. 데이터 삭제 또는 자동 정리(eviction)일 수 있습니다. 사라진 초안을 복구한다고 보장할 수 없습니다. 남은 입력은 복사하세요."
                    : "기기 저장소에 접근할 수 없어 초안 저장을 보장할 수 없습니다. 화면을 떠나거나 업데이트하기 전에 입력을 복사하세요."}
            </div>}
            {state.shell === "missing" && <div className="update-banner error" role="alert" data-testid="shell-warning">
                앱 cache가 삭제됐거나 자동 정리됐습니다. 현재 입력은 먼저 복사하세요. 오프라인 재실행은 보장되지 않으며, 온라인에서 새 UI를 확인하거나 다시 불러와야 합니다. 초안 저장소는 별개입니다.
            </div>}
        </aside>
    );
}
