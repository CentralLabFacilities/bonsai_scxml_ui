import { useCallback, useState } from "react";

export function useRuntimeValuesVisibility() {
    const [isOpen, setIsOpen] = useState(false);
    const onExecutionUpdate = useCallback(({ action }) => {
        if (["record_start", "record_resume"].includes(action)) setIsOpen(true);
        else if (["load", "loading"].includes(action)) setIsOpen(false);
    }, []);
    const close = useCallback(() => setIsOpen(false), []);
    const toggle = useCallback(() => setIsOpen((open) => !open), []);
    return { isOpen, onExecutionUpdate, close, toggle };
}
