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
