import { useCallback, useMemo, useRef, useState } from "react";
import { appendRuntimeEvent, emptyRuntimeTimeline, invalidateRuntimeTimeline } from "../../utils/runtimeEventFrames.js";

const initial = { ...emptyRuntimeTimeline(), index: -1, watching: true, revision: 0 };

export function useRuntimeEventTimeline() {
    const currentRef = useRef(initial);
    const [timeline, setTimeline] = useState(initial);
    const commit = useCallback((next) => { currentRef.current = next; setTimeline(next); }, []);
    const reset = useCallback(() => commit({ ...emptyRuntimeTimeline(), index: -1,
        watching: true, revision: currentRef.current.revision + 1 }), [commit]);
    const ingest = useCallback((message) => {
        const previous = currentRef.current;
        const next = appendRuntimeEvent(previous, message);
        if (next === previous) return;
        const selectedId = previous.frames[previous.index]?.id;
        const retainedIndex = next.frames.findIndex((frame) => frame.id === selectedId);
        commit({ ...next, index: previous.watching ? next.frames.length - 1 : Math.max(0, retainedIndex),
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
        commit({ ...previous, index: previous.frames.length - 1,
            watching: true, revision: previous.revision + 1 });
    }, [commit]);
    const markGap = useCallback(() => {
        const previous = currentRef.current;
        commit({ ...invalidateRuntimeTimeline(previous), revision: previous.revision + 1 });
    }, [commit]);
    // Resume is confirmed by the UI command response; the backend does not
    // publish a resume WebSocket event. Update current status without adding a
    // synthetic historical event or altering any saved frame.
    const confirmResume = useCallback(() => {
        const previous = currentRef.current;
        if (previous.status !== "PAUSED") return;
        commit({ ...previous, status: "RUNNING", revision: previous.revision + 1 });
    }, [commit]);
    // Old snapshot-based recovery is deliberately unsupported. Retained for callers
    // that may still invoke the old optional API; never synthesize runtime values.
    const seedBaseline = useCallback(() => {}, []);
    const selected = timeline.frames[timeline.index] || null;
    // The last completed skill / transition snapshot can be older than the
    // current execution. Live graph highlighting must follow state_entered and
    // other events even though these are not separate timeline snapshots.
    const frame = useMemo(() => {
        if (!timeline.watching) return selected?.finalScopes ? {
            ...selected, scopes: selected.finalScopes, variables: selected.finalVariables,
            parameters: selected.finalParameters,
        } : selected;
        const latest = timeline.lastEvent;
        if (!latest && !selected) return null;
        const kind = latest?.type === "transition" ? "transition" : "state";
        return {
            ...(selected || {}),
            id: `live:${latest?.sequence ?? timeline.lastSequence}`,
            kind,
            type: latest?.type || selected?.type,
            phase: latest?.type === "state_entered" ? "entering" : latest?.type === "state_exited"
                || latest?.type === "transition" ? "exiting" : "active",
            state: latest?.state || selected?.state || "",
            sequence: latest?.sequence ?? selected?.sequence,
            timestamp: latest?.timestamp ?? selected?.timestamp,
            transition: latest?.type === "transition" ? latest.transition : null,
            transitions: latest?.type === "transition" && latest.transition ? [latest.transition] : [],
            enteredStates: latest?.type === "state_entered" ? [latest.state] : [],
            exitedStates: latest?.type === "state_exited" ? [latest.state] : [],
            activeStates: timeline.activeStates,
            stateEntryHistory: timeline.stateEntryHistory,
            scopes: timeline.scopes,
            variables: timeline.variables,
            parameters: timeline.parameters,
            changes: timeline.pendingChanges || [],
            partiallyUnknown: timeline.partiallyUnknown,
        };
    }, [selected, timeline]);
    return { timeline, frame, ingest, reset, seek, goLive, markGap, seedBaseline, confirmResume };
}
