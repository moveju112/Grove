import { useState } from "react";
import { saveTimingEnabled, useTimingEnabled } from "./preference";

export function TurnTimingSetting() {
    const enabled = useTimingEnabled();
    const [error, setError] = useState(false);
    return (
        <div>
            <label className="check">
                <input type="checkbox" checked={enabled} onChange={(e) => {
                    try {
                        saveTimingEnabled(e.target.checked);
                        setError(false);
                    } catch {
                        setError(true);
                    }
                }} /> 턴 시간 표시
            </label>
            {error && <p className="err" role="alert">턴 시간 표시 설정을 저장하지 못했습니다. 브라우저 저장소 권한을 확인하세요.</p>}
        </div>
    );
}
