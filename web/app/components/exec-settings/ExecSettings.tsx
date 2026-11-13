import type { ExecSettingDef } from "../../api/execSettings";
import { ScopedSettings, type SettingsTarget } from "../ScopedSettings";

export function ExecSettings({ defs, target }: { defs: ExecSettingDef[]; target: SettingsTarget }) {
    return <div data-testid="exec-settings">
        <p>전역(서버 전체)보다 프로젝트, 프로젝트보다 대화 설정이 우선합니다. 이 범위 값을 지우면 상위 값을 상속합니다.</p>
        <p className="warn">변경은 다음에 계획하는 실행부터 적용됩니다. 이미 계획·승인된 호출의 shell·limits·cwd는 바꾸지 않습니다.</p>
        {defs.map((def) => <div key={def.key}>
            <fieldset disabled={Boolean(def.disabled_reason)} style={{ border: 0, padding: 0, margin: 0 }}>
                <ScopedSettings defs={[def]} target={target} />
            </fieldset>
            {def.disabled_reason && <p className="warn" role="status">{def.disabled_reason}</p>}
            {def.unavailable_options && def.unavailable_options.length > 0 && <fieldset disabled className="setting">
                <legend>{def.label} 미지원 선택지</legend>
                {def.unavailable_options.map((option) => <p key={option.value} className="muted small">
                    <label><input type="radio" name={`${def.key}-unsupported`} value={option.value} disabled /> {option.value} · {option.reason}</label>
                </p>)}
            </fieldset>}
            {def.key === "exec.default_cwd" && <p className="warn" role="status">
                cwd를 생략한 새 모델 셸·대화 작업에 적용됩니다. 명시한 cwd(‘.’ 포함)가 우선하며, 대화의 실제 실행 root(worktree 포함)를 기준으로 해석합니다. 프로젝트 script는 확인한 root에서 실행하고, 터미널·hook·외부 CLI에는 적용하지 않습니다.
            </p>}
        </div>)}
        <p className="muted small">프로세스 트리 격리는 파일·네트워크 sandbox가 아닙니다. 자원 한도 0은 제한 없음이며 CPU 시간은 경과 시간과 다릅니다. 대화 셸·한도는 모델 셸과 대화 작업에 적용되고, 새 프로젝트 터미널은 전역·프로젝트 셸만 사용합니다.</p>
    </div>;
}
