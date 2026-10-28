/** Explain the real control prerequisites rather than leaving two grey buttons. */
export function runtimeControlAvailability({
    status = null,
    statusStale = false,
    loadedCurrent = false,
    configuration = "",
    busy = false,
    browsing = false,
    eventConnection = "disconnected",
    refreshing = false,
} = {}) {
    const running = ["RUNNING", "PAUSED"].includes(status);
    const loading = status === "LOADING";
    const available = status !== null && !statusStale;
    const readyToStart = ["INITIALIZED", "INITIALIZED_BUT_WARNINGS"].includes(status);
    const connected = eventConnection === "connected";

    let loadReason = "";
    let startReason = "";
    if (busy) {
        loadReason = startReason = "Waiting for the engine to finish the current request.";
    } else if (browsing) {
        loadReason = startReason = "Selecting a configuration file.";
    } else {
        if (!String(configuration).trim()) loadReason = "Choose a configuration file in Run options.";
        else if (running) loadReason = statusStale
            ? "Last known engine status was running; reconnect to verify before loading."
            : "Stop the running state machine before loading another.";
        else if (loading) loadReason = "The engine is currently loading a state machine.";
        else if (!available) loadReason = refreshing
            ? "Checking engine status…" : "Engine status is unavailable. Check port 8080 and reconnect.";

        if (!connected) startReason = "Runtime event connection is offline. Reconnect before starting.";
        else if (!available) startReason = refreshing
            ? "Checking engine status…" : "Engine status is unavailable. Reconnect to refresh it.";
        else if (!loadedCurrent) startReason = "Load the current version of this workflow first.";
        else if (!readyToStart) startReason = running
            ? "The state machine is already running." : loading
                ? "Wait for loading to complete." : "The engine must be initialized before starting.";
    }
    return { canLoad: !loadReason, canStart: !startReason, loadReason, startReason };
}

/**
 * Run badge meaning is driven by HTTP engine availability, the last load
 * response and the engine's execution status. The event WebSocket is not an
 * HTTP connectivity check and must not decide whether the engine is online.
 *
 * `loadSucceeded` is null until a load responds (or is reset on restart).
 */
export function runtimeBadgeStatus({
    configuration = "",
    httpConnected = null,
    engineStatus = null,
    loadSucceeded = null,
    loading = false,
} = {}) {
    if (httpConnected !== true) return { label: "No connection", tone: "warning" };
    if (loading || engineStatus === "LOADING") return { label: "Loading", tone: "neutral" };
    if (engineStatus === "RUNNING") return { label: "Running", tone: "running" };
    if (engineStatus === "PAUSED") return { label: "Paused", tone: "paused" };
    if (!String(configuration).trim()) return { label: "No config selected", tone: "neutral" };
    if (loadSucceeded === false) return { label: "Loaded with errors", tone: "warning" };
    if (loadSucceeded === true || engineStatus === "INITIALIZED") {
        return { label: "Loaded", tone: "neutral" };
    }
    if (engineStatus === "INITIALIZED_BUT_WARNINGS") {
        return { label: "Loaded with errors", tone: "warning" };
    }
    return { label: "Nothing loaded", tone: "neutral" };
}
