import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { captureRuntimeSnapshot } from "../../utils/runtimeSnapshots.js";

const DEFAULT_DELAY = 800;
const MAX_SNAPSHOTS = 20000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const stateKey = (snapshot) => JSON.stringify([...(snapshot?.currentStates || [])].sort());
const executing = (status) => ["RUNNING", "PAUSED"].includes(status);
const initialView = { recording: null, frame: null, latestSnapshot: null, index: -1, started: false,
    playing: false, watching: true, visible: true, delay: DEFAULT_DELAY, epoch: 0, focusRequest: 0, focus: false, options: {} };

/** Arrival-order recording is independent of React batching and visual playback.
 * Frames are immutable; the private, bounded array is append-only for one run.
 */
export function useRuntimeSnapshots({ maxSnapshots = MAX_SNAPSHOTS, maxCacheBytes = MAX_CACHE_BYTES } = {}) {
    const cacheRef = useRef(null);
    const framesRef = useRef([]);
    const viewRef = useRef(initialView);
    const mountedRef = useRef(true);
    const waitingRef = useRef(false);
    const [view, setView] = useState(initialView);

    useLayoutEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; cacheRef.current = null; framesRef.current = []; };
    }, []);

    const commit = (patch) => {
        if (!mountedRef.current) return;
        viewRef.current = { ...viewRef.current, ...patch };
        setView(viewRef.current);
    };
    const metadata = (cache) => ({ workflow: cache.workflow, tabsSnapshot: cache.tabsSnapshot,
        session: cache.session, count: framesRef.current.length, engineStatus: cache.ended ? "Stopped" : cache.status,
        hasGap: cache.hasGap, truncated: cache.truncated, hasExecution: cache.observedActive });
    const select = (index, patch = {}) => {
        const cursor = Math.max(0, Math.min(index, framesRef.current.length - 1));
        commit({ frame: framesRef.current[cursor], index: cursor, started: true, visible: true,
            ...patch });
    };

    const recordExecutionUpdate = useCallback((update) => {
        if (!mountedRef.current) return;
        if (["load", "loading"].includes(update.action)) {
            cacheRef.current = null;
            framesRef.current = [];
            waitingRef.current = false;
            commit({ ...initialView, delay: viewRef.current.delay, epoch: viewRef.current.epoch + 1 });
            return;
        }
        let cache = cacheRef.current;
        const beginning = update.action === "record_start" || (!cache && update.workflow && update.following)
            || (update.action === "record_resume" && !cache);
        if (beginning || (update.workflow && cache && update.workflow !== cache.workflow)) {
            cache = { workflow: update.workflow, tabsSnapshot: update.tabsSnapshot || [update.workflow],
                session: {}, lastSource: null, latestSnapshot: null,
                status: "UNKNOWN", ended: false, observedActive: false,
                hasGap: false, truncated: false, awaitingResume: false, cachedBytes: 0 };
            cacheRef.current = cache;
            framesRef.current = [];
            waitingRef.current = false;
            commit({ ...initialView, delay: viewRef.current.delay, playing: true,
                recording: metadata(cache), epoch: viewRef.current.epoch + 1 });
        }
        if (!cache) return;
        let options = viewRef.current.options;
        for (const key of ["followCamera", "autoOpenSubMachines", "autoExpandCompounds", "autoExpandParallels"]) {
            if (key in update && options[key] !== update[key]) options = { ...options, [key]: update[key] };
        }
        if (update.action === "record_resume") {
            cache = { ...cache, awaitingResume: true, ended: false };
            waitingRef.current = false;
            commit({ watching: true, playing: true, visible: true, options, epoch: viewRef.current.epoch + 1 });
            if (framesRef.current.length) select(framesRef.current.length - 1, { focus: true, focusRequest: viewRef.current.focusRequest + 1 });
        }
        if (update.snapshot && update.workflow === cache.workflow) {
            const snapshot = update.snapshot;
            const event = update.runtimeEvent;
            const wasPaused = cache.status === "PAUSED";
            const changed = !cache.lastSource || snapshot.status !== cache.lastSource.status
                || stateKey(snapshot) !== stateKey(cache.lastSource) || snapshot.datamodel !== cache.lastSource.datamodel;
            if (event || changed) {
                const next = captureRuntimeSnapshot(cache.latestSnapshot, snapshot, event,
                    event?.datamodel !== undefined || snapshot.datamodel !== cache.lastSource?.datamodel);
                cache = { ...cache, latestSnapshot: next };
                const bytes = JSON.stringify(next).length * 2;
                if (!cache.truncated && framesRef.current.length < maxSnapshots && cache.cachedBytes + bytes <= maxCacheBytes) {
                    framesRef.current.push(next);
                    cache = { ...cache, cachedBytes: cache.cachedBytes + bytes };
                }
                else cache = { ...cache, truncated: true };
                if (waitingRef.current && viewRef.current.playing) {
                    waitingRef.current = false;
                    commit({ epoch: viewRef.current.epoch + 1 });
                }
                const current = viewRef.current;
                if (!cache.truncated && current.watching && !current.started && executing(next.status) && next.currentStates.length) {
                    select(framesRef.current.length - 1, { epoch: current.epoch + 1 });
                }
            }
            cache = { ...cache, lastSource: snapshot, status: snapshot.status,
                observedActive: cache.observedActive || executing(snapshot.status) };
            if (event && ["stopped", "terminal"].includes(event.type)
                || (cache.observedActive && !executing(snapshot.status))) cache = { ...cache, ended: true };
            if (snapshot.status === "RUNNING" || update.action === "resume") cache = { ...cache, awaitingResume: false };
            if (snapshot.status === "PAUSED" && !cache.awaitingResume && (!wasPaused || update.action === "resume")) {
                waitingRef.current = false;
                commit({ playing: false, watching: false, focus: false });
            }
            if (snapshot.eventStreamGap) cache = { ...cache, hasGap: true };
        }
        if (!update.snapshot && !update.following && update.workflow === cache.workflow
            && !["record_start", "record_resume"].includes(update.action)) {
            cache = { ...cache, hasGap: true };
            if (viewRef.current.watching) {
                waitingRef.current = false;
                commit({ started: false, playing: false, epoch: viewRef.current.epoch + 1 });
            }
        }
        if (update.action === "stop") {
            cache = { ...cache, ended: true, awaitingResume: false };
            waitingRef.current = false;
            commit({ started: false, playing: false, watching: false, focus: false, epoch: viewRef.current.epoch + 1 });
        }
        if (cache.truncated) commit({ playing: false, watching: false });
        cacheRef.current = cache;
        commit({ recording: metadata(cache), latestSnapshot: cache.latestSnapshot, options });
    // All control state is read synchronously from refs, including batched events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [maxSnapshots, maxCacheBytes]);

    useEffect(() => {
        if (!view.playing || !view.visible) return;
        const session = view.recording?.session;
        const epoch = view.epoch;
        const timer = window.setTimeout(() => {
            const cache = cacheRef.current;
            const current = viewRef.current;
            if (!mountedRef.current || cache?.session !== session || !current.playing || current.epoch !== epoch) return;
            const key = stateKey(current.frame);
            let boundary = false;
            let next = -1;
            for (let index = current.index + 1; index < framesRef.current.length; index += 1) {
                const frame = framesRef.current[index];
                if (!executing(frame.status) || !frame.currentStates.length || frame.event.type === "state_exited") { boundary = true; continue; }
                if (frame.event.data && !["state_entered", "snapshot"].includes(frame.event.type)) continue;
                if (stateKey(frame) !== key || boundary && frame.event.type === "state_entered" || !current.started) {
                    next = index;
                    break;
                }
            }
            if (next >= 0) select(next, { epoch: epoch + 1 });
            else if (cache.ended || cache.status === "PAUSED" && !cache.awaitingResume) {
                if (framesRef.current.length) select(framesRef.current.length - 1, { playing: false, epoch: epoch + 1 });
                else commit({ playing: false, epoch: epoch + 1 });
            } else {
                if (framesRef.current.length - 1 > current.index && current.started) select(framesRef.current.length - 1, { epoch: epoch + 1 });
                else waitingRef.current = true;
            }
        }, view.delay);
        return () => window.clearTimeout(timer);
    // Arrival notifications deliberately do not restart the pacing timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view.playing, view.visible, view.epoch, view.delay, view.recording?.session]);

    const seek = (index) => {
        const cache = cacheRef.current;
        if (!cache || !framesRef.current.length || !Number.isFinite(index)) return;
        waitingRef.current = false;
        select(Math.trunc(index), { playing: false, watching: false, focus: true,
            focusRequest: viewRef.current.focusRequest + 1, epoch: viewRef.current.epoch + 1 });
    };
    const restart = () => {
        const cache = cacheRef.current;
        if (!cache || !framesRef.current.length) return;
        waitingRef.current = false;
        const first = framesRef.current.findIndex((frame) => executing(frame.status) && frame.currentStates.length);
        select(Math.max(0, first), { playing: true, watching: false, focus: true,
            focusRequest: viewRef.current.focusRequest + 1, epoch: viewRef.current.epoch + 1 });
    };
    const toggle = () => {
        const cache = cacheRef.current;
        if (!cache || !framesRef.current.length) return;
        waitingRef.current = false;
        if (viewRef.current.playing) commit({ playing: false, watching: false, focus: false, epoch: viewRef.current.epoch + 1 });
        else if (!viewRef.current.started || viewRef.current.index >= framesRef.current.length - 1) restart();
        else commit({ playing: true, visible: true, epoch: viewRef.current.epoch + 1 });
    };
    const goLive = () => {
        const cache = cacheRef.current;
        if (!cache || !framesRef.current.length) return;
        waitingRef.current = false;
        select(framesRef.current.length - 1, { playing: !cache.ended && cache.status === "RUNNING" && !cache.truncated,
            watching: true, focus: true, focusRequest: viewRef.current.focusRequest + 1, epoch: viewRef.current.epoch + 1 });
    };
    const hide = () => commit({ visible: false, playing: false, watching: false, epoch: viewRef.current.epoch + 1 });
    const setDelay = (delay) => {
        if ([1400, 800, 400, 200].includes(delay)) commit({ delay, epoch: viewRef.current.epoch + 1 });
    };
    const step = (delta) => seek(viewRef.current.index + delta);
    const displayExecution = view.visible && view.started && executing(view.frame?.status) && view.frame?.currentStates.length && view.recording ? {
        workflow: view.recording.workflow, tabsSnapshot: view.recording.tabsSnapshot, session: view.recording.session,
        snapshot: view.frame, following: true, recordedPlayback: true, action: "replay",
        ...view.options, followCamera: Boolean(view.options.followCamera && (view.playing || view.focus)), focusRequest: view.focusRequest,
    } : null;
    const playback = {
        kind: "events", loaded: Boolean(view.recording?.count && view.visible),
        fileName: view.recording?.workflow?.title || "Recorded run",
        stepCount: view.recording?.count || 0, stepIndex: Math.max(0, view.index),
        started: view.started, isPlaying: view.playing, delay: view.delay,
        engineStatus: view.recording?.engineStatus, isLive: view.watching,
        hasGap: view.recording?.hasGap || false, truncated: view.recording?.truncated || false,
        currentStep: view.frame ? { states: view.frame.currentStates, timestamp: view.frame.timestamp, event: view.frame.event.type } : null,
    };
    return { recordExecutionUpdate, displayExecution, playback, selectedSnapshot: view.frame,
        hasExecution: Boolean(view.recording?.hasExecution),
        latestSnapshot: view.latestSnapshot, hasRecording: Boolean(view.recording?.count),
        restart, toggle, seek, step, setDelay, goLive, hide };
}
