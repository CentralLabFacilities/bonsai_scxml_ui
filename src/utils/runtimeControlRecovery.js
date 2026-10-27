/** A new connection needs an HTTP status baseline; reconnects do not replay events. */
export function runtimeConnectionNeedsStatusRefresh(previousConnection, connection) {
    return connection === "connected" && previousConnection !== "connected";
}

/** Do not overwrite a newer live event unless the old control status is unusable. */
export function shouldReplaceControlStatusBaseline(startedAtVersion, currentEventVersion, currentSnapshot) {
    return startedAtVersion === currentEventVersion || !currentSnapshot || currentSnapshot.statusStale === true;
}

/** A working HTTP server may still be loading or exposing partial control details. */
export function shouldRetryControlStatusSnapshot(snapshot) {
    return snapshot?.status === "LOADING" || snapshot?.detailsUnavailable === true;
}
