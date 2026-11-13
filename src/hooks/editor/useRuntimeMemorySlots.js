import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeMemoryPath, freezeSlotEventBoundary } from "../../utils/runtimeMemorySlots.js";
import { traceSlot, summarizeSlot } from "../../utils/slotReplayTrace.js";

const BASE = "http://127.0.0.1:8081";
const usingTauri = () =>
  typeof window !== "undefined" && (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined);
const empty = () => ({
  used: {},
  live: {},
  observations: [],
  writes: [],
  skillExecutions: [],
  connection: "disconnected",
  problem: "",
});
const validRecords = (records) =>
  Array.isArray(records)
    ? records
        .filter((item) => item?.path)
        .map((item) => ({ path: normalizeMemoryPath(item.path), type: String(item.type || "") }))
    : [];
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

/** Subscribe to write-time Memory SSE BEFORE the all-slot HTTP baseline.
 * Subsequent skill boundaries never trigger GET requests. */
export function useRuntimeMemorySlots() {
  const [view, setView] = useState(empty);
  const viewRef = useRef(view);
  const epochRef = useRef(0);
  const refreshRef = useRef(null);
  const usedPromiseRef = useRef(null);
  const occurrencesRef = useRef({});
  const mounted = useRef(true);
  const preparedStartRef = useRef(false);
  const streamRef = useRef(null);
  const retryRef = useRef(null);
  const writeVersionRef = useRef({});
  const writeOrderRef = useRef(0);
  const recordingRef = useRef(false);
  const commit = useCallback((transform) => {
    if (!mounted.current) return;
    const next = transform(viewRef.current);
    viewRef.current = next;
    setView(next);
  }, []);
  const stopStream = useCallback(() => {
    if (retryRef.current !== null) clearTimeout(retryRef.current);
    retryRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.active && stream?.cancel?.();
    stream?.close?.();
  }, []);
  const reset = useCallback(() => {
    stopStream();
    traceSlot("run.reset", {
      oldEpoch: epochRef.current,
      oldCaptures: viewRef.current.observations.length,
      oldLivePaths: Object.keys(viewRef.current.live),
    });
    epochRef.current += 1;
    usedPromiseRef.current = null;
    refreshRef.current = null;
    occurrencesRef.current = {};
    preparedStartRef.current = false;
    writeVersionRef.current = {};
    writeOrderRef.current = 0;
    recordingRef.current = false;
    commit(() => empty());
  }, [commit, stopStream]);
  // Skill execution boundaries remain independent of asynchronous HTTP GETs.
  // A response arriving after an entry is a later observation, never an
  // instantaneous value at the entry event.
  const noteSkillExit = useCallback(
    ({ state, entrySequence, exitSequence, enteredAt, exitedAt, slots = [] }) => {
      const endMs = Date.parse(exitedAt);
      const now = Date.now();
      commit((previous) => ({
        ...previous,
        skillExecutions: [
          ...previous.skillExecutions,
          {
            state,
            entrySequence,
            exitSequence,
            enteredAt,
            exitedAt,
            endedAtMs: Number.isFinite(endMs) ? endMs : now,
            receivedAtMs: now,
            slots: slots.map((slot) => ({ ...slot })),
          },
        ].slice(-5000),
      }));
    },
    [commit],
  );
  const readUsed = useCallback(async () => {
    if (usedPromiseRef.current) return usedPromiseRef.current;
    const epoch = epochRef.current;
    const task = getJson("/getUsedSlots")
      .then((records) => {
        const list = validRecords(records);
        traceSlot("getUsedSlots.result", {
          epoch,
          paths: list.map((item) => item.path),
          discarded: epoch !== epochRef.current,
        });
        if (epoch === epochRef.current)
          commit((previous) => ({
            ...previous,
            used: Object.fromEntries(list.map((item) => [item.path, item.type])),
            // A successful GET must not conceal an interrupted SSE stream.
            problem: previous.problem.startsWith("Cannot read MemorySlots") ? "" : previous.problem,
          }));
        return list;
      })
      .catch((error) => {
        traceSlot("getUsedSlots.error", { epoch, error: String(error) });
        if (epoch === epochRef.current)
          commit((previous) => ({
            ...previous,
            live: Object.fromEntries(
              Object.entries(previous.live).map(([path, value]) => [path, { ...value, stale: true }]),
            ),
            problem: `Cannot read MemorySlots from ${BASE}: ${String(error)}. ${
              usingTauri()
                ? "Check the native Memory bridge and Memory WebSupport."
                : "Check Memory WebSupport and browser CORS permissions."
            }`,
          }));
        throw error;
      });
    usedPromiseRef.current = task;
    try {
      return await task;
    } finally {
      if (usedPromiseRef.current === task) usedPromiseRef.current = null;
    }
  }, [commit]);
  const readSlot = useCallback(async (path) => {
    try {
      const data = await getJson(`/getSlot?path=${encodeURIComponent(path)}`);
      const result = {
        path: normalizeMemoryPath(data.path || path),
        type: String(data.type || ""),
        value: String(data.value ?? "null"),
        status: "available",
      };
      traceSlot("getSlot.result", { requestedPath: path, result: summarizeSlot(result) });
      return result;
    } catch (error) {
      traceSlot("getSlot.error", { requestedPath: path, error: String(error) });
      throw error;
    }
  }, []);
  // Snapshot the entire discovered memory before Start; after a stream gap a
  // new snapshot is a resync observation, never silently a historical write.
  // Version counters stop a GET in flight overwriting a newer SSE value.
  const refresh = useCallback(async (kind = "pre-start") => {
    if (refreshRef.current) return refreshRef.current;
    const epoch = epochRef.current;
    const versions = { ...writeVersionRef.current };
    const task = (async () => {
      const list = [...new Map((await readUsed()).map((item) => [item.path, item])).values()];
      const results = await Promise.allSettled(list.map(({ path }) => readSlot(path)));
      if (epoch !== epochRef.current) return;
      const observedAtPerf = performance.now();
      const observedAtMs = Date.now();
      const observedAt = new Date(observedAtMs).toISOString();
      commit((previous) => {
        const live = { ...previous.live };
        const cache = list.map((item, index) => {
          const newerEvent = (writeVersionRef.current[item.path] || 0) !== (versions[item.path] || 0);
          if (newerEvent) {
            // This event was received after the HTTP snapshot started. Its
            // captured write-time value is preferable to an old GET result.
            return { ...item, ...live[item.path], observationSource: "sse-during-snapshot" };
          }
          const result = results[index];
          const value = result.status === "fulfilled"
            ? { ...result.value, observationSource: kind === "pre-start" ? "getSlot-before-start" : "getSlot-resync", observedAt }
            : { ...item, status: "unavailable", observationSource: kind === "pre-start" ? "getSlot-before-start" : "getSlot-resync", observedAt };
          if (value.status === "available") live[item.path] = { ...value, stale: false };
          return value;
        });
        traceSlot("refresh.snapshot", { epoch, kind, paths: list.map((item) => item.path), cache: cache.map(summarizeSlot) });
        const missing = results.some((result) => result.status === "rejected");
        return {
          ...previous,
          live,
          observations: [
            ...previous.observations,
            { state: "", kind, sequence: null, observedAtPerf, observedAtMs, observedAt, slots: [], cache },
          ].slice(-5000),
          problem: missing
            ? "Some MemorySlots could not be read during the memory snapshot."
            : previous.problem,
        };
      });
    })();
    refreshRef.current = task;
    try {
      await task;
    } catch (error) {
      if (epoch === epochRef.current)
        commit((previous) => ({ ...previous, problem: previous.problem || `Memory refresh failed: ${String(error)}` }));
    } finally {
      if (refreshRef.current === task) refreshRef.current = null;
    }
  }, [commit, readSlot, readUsed]);

  // Each reconnect creates a new stream; old channel callbacks are ignored.
  // A disconnect is an explicit historical gap: an SSE replay is not available.
  const ensureSubscription = useCallback((reconnecting = false) => {
    const existing = streamRef.current;
    if (existing) return existing.ready;
    if (retryRef.current !== null) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    const epoch = epochRef.current;
    let resolveReady;
    const transport = {
      active: true,
      connected: false,
      close: () => {},
      ready: new Promise((resolve) => { resolveReady = resolve; }),
      cancel: () => { transport.active = false; resolveReady(false); },
    };
    streamRef.current = transport;
    const active = () => mounted.current && epoch === epochRef.current &&
      streamRef.current === transport && transport.active;
    const markInterrupted = (reason) => {
      if (!active()) return;
      const wasConnected = transport.connected;
      transport.active = false;
      streamRef.current = null;
      transport.close();
      resolveReady(false);
      const observedAtMs = Date.now();
      commit((previous) => ({
        ...previous,
        connection: "reconnecting",
        live: Object.fromEntries(Object.entries(previous.live)
          .map(([path, value]) => [path, { ...value, stale: true }])),
        observations: wasConnected
          ? [...previous.observations, { state: "", kind: "stream-gap", observedAtMs,
              observedAtPerf: performance.now(), observedAt: new Date(observedAtMs).toISOString(),
              slots: [], cache: [] }].slice(-5000)
          : previous.observations,
        problem: `${reason} Historical MemorySlot writes may be missing until resynchronization.`,
      }));
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        if (mounted.current && epoch === epochRef.current) void ensureSubscription(true);
      }, 1500);
    };
    const onConnected = () => {
      if (!active() || transport.connected) return;
      transport.connected = true;
      resolveReady(true);
      commit((previous) => ({ ...previous, connection: "connected",
        problem: previous.problem.includes("Historical MemorySlot writes may be missing")
          ? "Memory stream was interrupted; some historical writes may be missing." : previous.problem }));
      if (reconnecting) void refresh("resync");
    };
    const onSlotEvent = (name, raw) => {
      if (!active()) return;
      if (name === "resync_required") {
        markInterrupted("Memory SSE queue overflow; resync required.");
        return;
      }
      if (name !== "slot_written" && name !== "slot_cleared") return;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return; }
      const path = normalizeMemoryPath(parsed?.path);
      if (!path) return;
      writeVersionRef.current[path] = (writeVersionRef.current[path] || 0) + 1;
      const observedAtMs = Date.now();
      const observedAtPerf = performance.now();
      const observedAt = new Date(observedAtMs).toISOString();
      const value = name === "slot_cleared" ? "null" : String(parsed.value ?? "null");
      const order = ++writeOrderRef.current;
      traceSlot("sse.slot", { name, path, order, value: value.slice(0, 200) });
      // Updates before the initial snapshot finishes belong to the baseline,
      // not to any subsequently entered skill.
      const duringRun = recordingRef.current;
      commit((previous) => ({
        ...previous,
        writes: duringRun
          ? [...previous.writes, { path, value, name, status: "available", order,
              observedAtMs, observedAtPerf, observedAt }].slice(-5000)
          : previous.writes,
        live: {
          ...previous.live,
          [path]: { path, value, type: previous.used[path] || previous.live[path]?.type || "",
            status: "available", stale: false, observedAt, observationSource: "sse-write" },
        },
      }));
    };
    commit((previous) => ({ ...previous,
      connection: reconnecting ? "reconnecting" : "connecting" }));
    const timeout = setTimeout(() => markInterrupted("Memory SSE connection timed out."), 5000);
    const cancelTimeout = () => clearTimeout(timeout);
    // Keep all callbacks on the same transport token so neither a delayed
    // native subscription response nor a previous stream can mutate this run.
    if (usingTauri()) {
      let invokeNative = null;
      let streamId = null;
      transport.close = () => {
        cancelTimeout();
        if (invokeNative && streamId !== null)
          void invokeNative("memory_unsubscribe", { streamId }).catch(() => {});
      };
      void (async () => {
        try {
          const { invoke, Channel } = await import("@tauri-apps/api/core");
          if (!active()) return;
          invokeNative = invoke;
          const channel = new Channel();
          channel.onmessage = (message) => {
            if (!active()) return;
            if (message.type === "connected") onConnected();
            else if (message.type === "event") onSlotEvent(message.name, message.data);
            else if (message.type === "error") markInterrupted(`Memory SSE: ${message.message}`);
          };
          const id = await invoke("memory_subscribe", { onEvent: channel });
          if (!active()) {
            void invoke("memory_unsubscribe", { streamId: id }).catch(() => {});
          } else {
            streamId = id;
          }
        } catch (error) {
          markInterrupted(`Cannot subscribe to Memory SSE via Tauri: ${String(error)}.`);
        }
      })();
    } else {
      let source;
      transport.close = () => { cancelTimeout(); source?.close(); };
      try {
        source = new EventSource(`${BASE}/events`);
        source.onopen = onConnected;
        source.addEventListener("slot_written", (event) => onSlotEvent("slot_written", event.data));
        source.addEventListener("slot_cleared", (event) => onSlotEvent("slot_cleared", event.data));
        source.addEventListener("resync_required", (event) => onSlotEvent("resync_required", event.data));
        source.onerror = () => markInterrupted("Memory SSE connection interrupted (check browser CORS). ");
      } catch (error) {
        markInterrupted(`Cannot open Memory SSE: ${String(error)}.`);
      }
    }
    void transport.ready.then(cancelTimeout);
    return transport.ready;
  }, [commit, refresh]);

  const prepareStart = useCallback(async () => {
    // Subscribe first to avoid losing writes between the initial HTTP read
    // and the Start command. A failed SSE connection is explicitly reported,
    // but must not prevent the state machine from starting.
    const epoch = epochRef.current;
    await ensureSubscription();
    await refresh("pre-start");
    if (epoch === epochRef.current) {
      preparedStartRef.current = true;
      recordingRef.current = true;
    }
  }, [refresh, ensureSubscription]);
  const consumePreparedStart = useCallback(() => {
    const prepared = preparedStartRef.current;
    preparedStartRef.current = false;
    return prepared;
  }, []);

  // Runtime events freeze already-observed data. Writes arrive separately
  // via SSE and are attributed to skills only as a clearly marked inference.
  const capture = useCallback((state, slots, sequence, kind = "skill-exit", entrySequence = null) => {
    const occurrence = (occurrencesRef.current[state] || 0) + (kind === "skill-entry" ? 1 : 0);
    if (kind === "skill-entry") occurrencesRef.current[state] = occurrence;
    const observedAtMs = Date.now();
    const boundary = freezeSlotEventBoundary(slots, viewRef.current.live, {
      state, occurrence, sequence, entrySequence, kind, observedAtMs,
      observedAtPerf: performance.now(), observedAt: new Date(observedAtMs).toISOString(),
    });
    commit((previous) => ({ ...previous,
      observations: [...previous.observations, boundary].slice(-5000),
    }));
    traceSlot("capture.boundary", { state, kind, sequence,
      mappedPaths: (slots || []).map((slot) => slot.path),
      cache: boundary.cache.map(summarizeSlot) });
  }, [commit]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epochRef.current += 1;
      stopStream();
    };
  }, [stopStream]);
  return { ...view, reset, refresh, prepareStart, consumePreparedStart, capture, noteSkillExit };
}
