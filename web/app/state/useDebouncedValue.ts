import { useEffect, useState } from "react";

/** 입력은 즉시 표시하고 읽기 조건의 갱신만 합친다. */
export function useDebouncedValue<T>(value: T, delay = 150): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return settled;
}
