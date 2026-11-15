import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { useState } from "react";
import { saveTimingEnabled, useTimingEnabled } from "./preference";
import { BooleanSelect } from "../BooleanSelect";

export function TurnTimingSetting() {
    const enabled = useTimingEnabled();
    const [error, setError] = useState(false);
    return (
        <GroveStack gap={0}>
            <BooleanSelect label="턴 시간 표시" value={enabled} onChange={(value) => {
                    try {
                        saveTimingEnabled(value);
                        setError(false);
                    } catch {
                        setError(true);
                    }
                }} />
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">턴 시간 표시 설정을 저장하지 못했습니다. 브라우저 저장소 권한을 확인하세요.</GroveText>}
        </GroveStack>
    );
}
