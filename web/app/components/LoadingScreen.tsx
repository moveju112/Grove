import { ProgressBar } from "@astryxdesign/core/ProgressBar";

/** 화면 상단에 고정되는 진행 표시줄. 기다리는 동안 기존 화면과 입력은 그대로 둔다. */
export function LoadingBar({ label }: { label: string }) {
    return <div className="loading-bar" data-testid="loading-bar">
        <ProgressBar isIndeterminate isLabelHidden label={label} variant="neutral" />
    </div>;
}

/** 표시할 화면이 아직 없을 때 쓰는 전체 로딩 화면. */
export function LoadingScreen({ label }: { label: string }) {
    return <div className="boot loading-screen" aria-busy="true">
        <LoadingBar label={label} />
        <p role="status">{label}</p>
    </div>;
}
