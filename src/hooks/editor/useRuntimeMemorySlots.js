import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeMemoryPath, captureSlotEntries, freezeSlotEventBoundary } from "../../utils/runtimeMemorySlots.js";
import { traceSlot, summarizeSlot } from "../../utils/slotReplayTrace.js";

const BASE = "http://127.0.0.1:8081";
const usingTauri = () => typeof window !== "undefined" &&
    (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined);
const empty = () => ({ used: {}, live: {}, observations: [], writes: [], skillExecutions: [], connection: "disconnected", problem: "" });
const validRecords = (records) => Array.isArray(records) ? records.filter((item) => item?.path)
    .map((item) => ({ path: normalizeMemoryPath(item.path), type: String(item.type || "") })) : [];
const getJson = async (path) => {
    // In Tauri/WebKitGTK, direct fetch to :8081 can fail because the Java
    // endpoint does not expose the webview's origin via CORS. Rust IPC makes
    // the same fixed loopback GET without changing Memory WebSupport.
    if (usingTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        if (path === "/getUsedSlots") return invoke("memory_used_slots");
        if (path.startsWith("/getSlot?path=")) {
            const slotPath = decodeURIComponent(path.slice("/getSlot?path=".length));
            return invoke("memory_get_slot", { path: slotPath });
        }
        throw new Error("Unsupported Memory endpoint");
    }
    const result = await fetch(`${BASE}${path}`, { cache: "no-store" });
    if (!result.ok) throw new Error(`Memory WebSupport HTTP ${result.status}`);
    return result.json();
};

/** Memory SSE is unordered relative to SCXML WebSocket. Never use its arrival
 * order as a reliable writer identity. No polling; read on state exit / connect. */
export function useRuntimeMemorySlots({ enabled }) {
    const [view, setView] = useState(empty);
    const viewRef = useRef(view);
    const epochRef = useRef(0);
    const refreshRef = useRef(null);
    const usedPromiseRef = useRef(null);
    const writeVersionRef = useRef({});
    const occurrencesRef = useRef({});
    const mounted = useRef(true);
    const commit = useCallback((transform) => {
        if (!mounted.current) return;
        const next = transform(viewRef.current);
        viewRef.current = next;
        setView(next);
    }, []);
    const reset = useCallback(() => {
        traceSlot("run.reset", { oldEpoch: epochRef.current, oldCaptures: viewRef.current.observations.length,
            oldLivePaths: Object.keys(viewRef.current.live) });
        epochRef.current += 1;
        usedPromiseRef.current = null;
        refreshRef.current = null;
        writeVersionRef.current = {};
        occurrencesRef.current = {};
        commit((previous) => ({ ...empty(), connection: previous.connection }));
    }, [commit]);
    // Preserve skill execution boundaries independently of asynchronous GETs.
    // The backend timestamp and SSE receive time are both wall-clock values;
    // exact cross-stream ordering is not assumed. Replay reconciles them using
    // writable slot declarations and ordered skill executions.
    const noteSkillExit = useCallback(({ state, entrySequence, exitSequence,
        enteredAt, exitedAt, slots = [] }) => {
        const endMs = Date.parse(exitedAt);
        const now = Date.now();
        commit((previous) => ({ ...previous, skillExecutions: [
            ...previous.skillExecutions,
            { state, entrySequence, exitSequence, enteredAt,
                exitedAt, endedAtMs: Number.isFinite(endMs) ? endMs : now,
                receivedAtMs: now, slots: slots.map((slot) => ({ ...slot })) },
        ].slice(-5000) }));
    }, [commit]);
    const readUsed = useCallback(async () => {
        if (usedPromiseRef.current) return usedPromiseRef.current;
        const epoch = epochRef.current;
        const task = getJson("/getUsedSlots").then((records) => {
            const list = validRecords(records);
            traceSlot("getUsedSlots.result", { epoch, paths: list.map((item) => item.path),
                discarded: epoch !== epochRef.current });
            if (epoch === epochRef.current) commit((previous) => ({ ...previous,
                used: Object.fromEntries(list.map((item) => [item.path, item.type])), problem: "" }));
            return list;
        }).catch((error) => {
            traceSlot("getUsedSlots.error", { epoch, error: String(error) });
            if (epoch === epochRef.current) commit((previous) => ({ ...previous,
                problem: `Cannot read MemorySlots from ${BASE}: ${String(error)}. ${usingTauri()
                    ? "Check the native Memory bridge and Memory WebSupport."
                    : "Check Memory WebSupport and browser CORS permissions."}` }));
            throw error;
        });
        usedPromiseRef.current = task;
        try { return await task; } finally { if (usedPromiseRef.current === task) usedPromiseRef.current = null; }
    }, [commit]);
    const readSlot = useCallback(async (path) => {
        try {
            const data = await getJson(`/getSlot?path=${encodeURIComponent(path)}`);
            const result = { path: normalizeMemoryPath(data.path || path), type: String(data.type || ""),
                value: String(data.value ?? "null"), status: "available" };
            traceSlot("getSlot.result", { requestedPath: path, result: summarizeSlot(result) });
            return result;
        } catch (error) {
            traceSlot("getSlot.error", { requestedPath: path, error: String(error) });
            throw error;
        }
    }, []);
    const refresh = useCallback(async () => {
        if (refreshRef.current) return refreshRef.current;
        const epoch = epochRef.current;
        const task = (async () => {
            const writeVersions = { ...writeVersionRef.current };
            const list = await readUsed();
            const results = await Promise.allSettled(list.map(({ path }) => readSlot(path)));
            if (epoch !== epochRef.current) return;
            traceSlot("refresh.result", { epoch, receivedPaths: list.map((item) => item.path),
                results: results.map((result, i) => ({ requestedPath: list[i]?.path,
                    status: result.status, value: result.status === "fulfilled" ? summarizeSlot(result.value) : String(result.reason) })) });
            commit((previous) => {
                const live = { ...previous.live };
                results.forEach((result, i) => {
                    if (result.status === "fulfilled" &&
                        (writeVersionRef.current[list[i].path] || 0) === (writeVersions[list[i].path] || 0))
                        live[list[i].path] = { ...result.value, stale: false };
                });
                return { ...previous, live };
            });
        })();
        refreshRef.current = task;
        try { await task; } catch (error) {
            if (epoch === epochRef.current) commit((prev) => ({ ...prev,
                problem: prev.problem || `Memory refresh failed: ${String(error)}` }));
        } finally { if (refreshRef.current === task) refreshRef.current = null; }
    }, [commit, readSlot, readUsed]);
    const capture = useCallback(async (state, slots, sequence, kind = "skill-exit", entrySequence = null) => {
        const epoch = epochRef.current;
        const occurrence = (occurrencesRef.current[state] || 0) + (kind === "skill-exit" ? 1 : 0);
        if (kind === "skill-exit") occurrencesRef.current[state] = occurrence;
        const writeVersions = { ...writeVersionRef.current };
        const liveAtEvent = { ...viewRef.current.live };
        const boundaryMs = Date.now();
        const boundary = freezeSlotEventBoundary(slots, liveAtEvent, {
            state, occurrence, sequence, entrySequence, kind,
            observedAtMs: boundaryMs, observedAtPerf: performance.now(),
            observedAt: new Date(boundaryMs).toISOString(),
        });
        // IMPORTANT: commit before the first await. Both the SCXML stream and
        // the Memory stream are asynchronous, and Java can execute the next
        // skill long before GET responds. Every frame therefore owns an
        // immutable observation of what was known at its actual event boundary.
        commit((previous) => ({ ...previous, observations: [
            ...previous.observations, boundary,
        ].slice(-5000) }));
        traceSlot("capture.boundary", { epoch, state, kind, sequence, entrySequence,
            mappedPaths: (slots || []).map((slot) => slot.path),
            cache: boundary.cache.map(summarizeSlot) });

        // Keep HTTP for live-value discovery, NOT as a replacement for an
        // earlier frame. If its result is observed later, record that later
        // sample separately; subsequent frames can use it, but past ones can't.
        let used;
        try { used = await readUsed(); } catch { used = null; }
        const { slots: entries, cache } = await captureSlotEntries(
            slots, used, liveAtEvent, readSlot, {
                changedAfterEvent: (path) =>
                    (writeVersionRef.current[path] || 0) !== (writeVersions[path] || 0),
            });
        if (epoch !== epochRef.current) {
            traceSlot("capture.discarded", { epoch, currentEpoch: epochRef.current,
                state, kind, sequence, entrySequence });
            return;
        }
        traceSlot("capture.read", { epoch, state, kind, sequence, entrySequence,
            usedPaths: used?.map((item) => item.path) ?? null,
            mapped: entries.map(summarizeSlot), cached: cache.map(summarizeSlot) });
        const observedAtPerf = performance.now();
        const observedAtMs = Date.now();
        const observedAt = new Date(observedAtMs).toISOString();
        const laterSamples = cache.filter((item) => item.status === "available" &&
            item.observationSource === "getSlot-after-event" &&
            (writeVersionRef.current[item.path] || 0) === (writeVersions[item.path] || 0));
        commit((previous) => {
            const live = { ...previous.live };
            for (const item of laterSamples) {
                live[item.path] = { ...item, stale: false, observedAt };
            }
            return { ...previous, live, observations: laterSamples.length ? [
                ...previous.observations,
                { state, kind: "http-read", sequence: null, occurrence,
                    observedAtPerf, observedAtMs, observedAt,
                    slots: [], cache: laterSamples.map((item) => ({ ...item, observedAt })) },
            ].slice(-5000) : previous.observations };
        });
        traceSlot("capture.completed", { epoch, state, kind, sequence, entrySequence,
            savedAtEvent: boundary.cache.map(summarizeSlot),
            laterReadPaths: laterSamples.map((item) => item.path) });
    }, [commit, readSlot, readUsed]);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; epochRef.current += 1; };
    }, []);
    useEffect(() => {
        if (!enabled) return undefined;
        let source;
        let cancelled = false;
        let retryTimer;
        let nativeInvoke = null;
        let nativeStreamId = null;
        const onConnected = () => {
            if (cancelled) return;
            commit((prev) => ({ ...prev, connection: "connected", problem: "" }));
            void refresh();
        };
        const onInterrupted = (message) => {
            if (cancelled) return;
            commit((prev) => ({ ...prev,
                connection: "reconnecting",
                live: Object.fromEntries(Object.entries(prev.live)
                    .map(([path, value]) => [path, { ...value, stale: true }])),
                problem: message || "Memory event connection interrupted; intermediate writes may be missing.",
            }));
        };
        const onSlotEvent = (name, data) => {
            if (cancelled || (name !== "slot_written" && name !== "slot_cleared")) return;
            let entry;
            try { entry = JSON.parse(data); } catch { return; }
            const path = normalizeMemoryPath(entry.path);
            if (!path) return;
            traceSlot("sse.slot", { name, path, value: String(entry.value ?? "null").slice(0, 200) });
            writeVersionRef.current[path] = (writeVersionRef.current[path] || 0) + 1;
            const observedAtMs = Date.now();
            const observedAt = new Date(observedAtMs).toISOString();
            const value = name === "slot_cleared" ? "null" : String(entry.value ?? "null");
            commit((prev) => ({ ...prev,
                writes: [...prev.writes, { path, value, name, status: "available",
                    observedAtMs, observedAt, order: prev.writes.length }].slice(-5000),
                live: { ...prev.live, [path]: {
                    path, type: prev.used[path] || prev.live[path]?.type || "",
                    value, status: "available", stale: false, observedAt,
                } } }));
            // Slot discovery remains event-driven on state exits, not polled.
        };
        if (usingTauri()) {
            // Tauri event channels carry the SSE stream over native IPC. The
            // browser never needs to connect directly to the CORS-less server.
            const connectNative = async () => {
                if (cancelled) return;
                try {
                    const { invoke, Channel } = await import("@tauri-apps/api/core");
                    if (cancelled) return;
                    nativeInvoke = invoke;
                    const channel = new Channel();
                    channel.onmessage = (event) => {
                        if (cancelled) return;
                        if (event.type === "connected") onConnected();
                        else if (event.type === "event") onSlotEvent(event.name, event.data);
                        else if (event.type === "error") {
                            onInterrupted(`Memory SSE: ${event.message}`);
                            retryTimer = setTimeout(() => { void connectNative(); }, 1500);
                        }
                    };
                    const streamId = await invoke("memory_subscribe", { onEvent: channel });
                    if (cancelled) void invoke("memory_unsubscribe", { streamId }).catch(() => {});
                    else nativeStreamId = streamId;
                } catch (error) {
                    onInterrupted(`Cannot subscribe to Memory SSE via Tauri: ${String(error)}`);
                    if (!cancelled) retryTimer = setTimeout(() => { void connectNative(); }, 1500);
                }
            };
            void connectNative();
        } else {
            // Non-Tauri development preview; requires Memory WebSupport CORS.
            try {
                source = new EventSource(`${BASE}/events`);
                source.onopen = onConnected;
                source.addEventListener("slot_written", (event) => onSlotEvent("slot_written", event.data));
                source.addEventListener("slot_cleared", (event) => onSlotEvent("slot_cleared", event.data));
                source.onerror = () => onInterrupted("Memory event connection interrupted; intermediate writes may be missing.");
            } catch (error) { onInterrupted(String(error)); }
        }
        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            source?.close();
            if (nativeInvoke && nativeStreamId !== null)
                void nativeInvoke("memory_unsubscribe", { streamId: nativeStreamId }).catch(() => {});
        };
    }, [enabled, commit, refresh]);
    return { ...view, reset, refresh, capture, noteSkillExit };
}
