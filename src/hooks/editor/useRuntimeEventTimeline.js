import { useCallback, useRef, useState } from "react";
import { appendRuntimeEvent, emptyRuntimeTimeline } from "../../utils/runtimeEventFrames.js";
import { getRuntimeBaselineValues } from "../../utils/runtimeValueDisplay.js";

const initial = { ...emptyRuntimeTimeline(), index: -1, watching: true, revision: 0 };

export function useRuntimeEventTimeline() {
    const currentRef = useRef(initial);
    const [timeline, setTimeline] = useState(initial);
    const commit = useCallback((next) => {
        currentRef.current = next;
        setTimeline(next);
    }, []);
    const reset = useCallback(() => commit({ ...emptyRuntimeTimeline(), index: -1,
        watching: true, revision: currentRef.current.revision + 1 }), [commit]);
    const ingest = useCallback((message) => {
        const previous = currentRef.current;
        const next = appendRuntimeEvent(previous, message);
        if (next === previous) return;
        const selectedId = previous.frames[previous.index]?.id;
        const retainedIndex = next.frames.findIndex((frame) => frame.id === selectedId);
        commit({ ...next, index: previous.watching ? next.frames.length - 1
            : Math.max(0, retainedIndex),
            watching: previous.watching, revision: previous.revision + 1 });
    }, [commit]);
    const seek = useCallback((index) => {
        const previous = currentRef.current;
        if (!previous.frames.length) return;
        commit({ ...previous, index: Math.max(0, Math.min(previous.frames.length - 1, Number(index) || 0)),
            watching: false, revision: previous.revision + 1 });
    }, [commit]);
    const goLive = useCallback(() => {
        const previous = currentRef.current;
        commit({ ...previous, index: previous.frames.length - 1, watching: true, revision: previous.revision + 1 });
    }, [commit]);
    const seedBaseline = useCallback((snapshot) => {
        const values = getRuntimeBaselineValues(snapshot);
        if (!Object.keys(values).length) return;
        const previous = currentRef.current;
        // Already observed assignment events are authoritative. Baselines only
        // fill missing data, never replace a value delivered by the stream.
        const missing = Object.fromEntries(Object.entries(values)
            .filter(([name]) => !Object.hasOwn(previous.variables || {}, name)));
        if (!Object.keys(missing).length) return;
        const variables = { ...(previous.variables || {}), ...missing };
        const frames = [...previous.frames];
        if (frames.length) frames[frames.length - 1] = { ...frames.at(-1),
            variables: { ...missing, ...frames.at(-1).variables } };
        commit({ ...previous, variables, frames, revision: previous.revision + 1 });
    }, [commit]);
    const markGap = useCallback(() => {
        const previous = currentRef.current;
        commit({ ...previous, hasGap: true, revision: previous.revision + 1 });
    }, [commit]);
    const frame = timeline.frames[timeline.index] || null;
    return { timeline, frame, ingest, reset, seek, goLive, markGap, seedBaseline };
}
