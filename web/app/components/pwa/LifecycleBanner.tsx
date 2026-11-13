import { useEffect } from "react";
import { checkCompatibility, inspectLocalDrafts, inspectStoragePolicy, startLifecycle, useLifecycle } from "./lifecycle";
import "./pwa.css";

export function LifecycleBanner() {
    const state = useLifecycle();
    useEffect(startLifecycle, []);
    return (
        <aside className="pwa-lifecycle" aria-label="PWA 상태" data-testid="pwa-lifecycle">
            {!state.online && <div className="update-banner" role="status" data-testid="offline-banner">
                오프라인 · 초안만 작성할 수 있습니다. 전송·승인·도구 실행은 연결 후 직접 다시 시도하세요. 서버의 기존 작업이 중단됐다는 뜻은 아닙니다.
            </div>}
            {state.online && state.connection === "unreachable" && <div className="update-banner error" role="alert">
                서버에 연결할 수 없습니다. 현재 탭에서 초안을 작성할 수 있지만 서버 작업은 사용할 수 없습니다.
                <button onClick={() => void checkCompatibility()}>연결 다시 확인</button>
            </div>}
            <details className="draft-note" data-testid="storage-limits">
                <summary>로컬 초안 보존 한계</summary>
                <p>초안은 이 브라우저·기기에만 저장됩니다. 브라우저 데이터 삭제, 저장 공간 부족, 브라우저의 자동 정리(eviction)로 사라질 수 있습니다. 중요한 글은 별도로 복사하거나 연결 후 서버 초안으로 저장하세요.</p>
                <p>앱 cache와 초안 저장소는 별개입니다. 앱 cache를 다시 받아도 삭제된 초안은 복구되지 않습니다. 앱을 다시 열 때 서버 인증·대화 목록이 없으면 오프라인에서 기존 초안 화면까지 복원되지 않을 수 있습니다.</p>
                {state.storageApi === "unsupported" && <p>navigator.storage 미지원: 저장 정책·영구 보관 여부를 확인할 수 없습니다. 로컬 초안 저장 미지원과는 다릅니다.</p>}
                {state.storageApi === "unavailable" && <p>브라우저 저장 정책 조회가 거부됐습니다. 초안 보존 여부를 확인할 수 없습니다.</p>}
                {state.persistence === "best-effort" && <p>이 origin은 영구 보관 승인을 받지 않았습니다. 브라우저가 저장 데이터를 자동 정리할 수 있습니다.</p>}
                {state.persistence === "persistent" && <p>이 origin은 영구 보관 상태지만, 사용자의 데이터 삭제나 localStorage 초안 보존까지 보장하지 않습니다.</p>}
                <p>모든 브라우저 데이터를 지운 뒤의 재방문과 첫 방문은 구분할 수 없으며, 유실을 항상 감지할 수는 없습니다.</p>
                <button className="ghost small" onClick={() => { inspectLocalDrafts(); void inspectStoragePolicy(); }}>저장소 다시 확인</button>
            </details>
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
