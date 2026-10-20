import { useEffect, useRef, useState } from "react";
import { getWebCommanderEventSnapshot } from "../../utils/webCommander.js";

/** Direct WebSocket to WebCommander. Fetch is proxied in Tauri, WebSocket is not. */
export function bonsaiRuntimeSocketUrl() {
    const secure = window.location.protocol === "https:";
    // Desktop, localhost dev server and embedded UI all connect to the running WebCommander.
    const host = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? window.location.hostname : "localhost";
    return `${secure ? "wss" : "ws"}://${host}:8080/bonsai/ws`;
}

export function useBonsaiRuntimeSocket({ enabled, onEvent, onResync, onConnectionIssue }) {
    const callbacks = useRef({ onEvent, onResync, onConnectionIssue });
    callbacks.current = { onEvent, onResync, onConnectionIssue };
    const checkpoint = useRef({ runId: null, sequence: 0 });
    const [connection, setConnection] = useState("disconnected");
    const [generation, reconnect] = useState(0);
    const reconnectNow = () => reconnect((number) => number + 1);

    useEffect(() => {
        if (!enabled) { setConnection("disconnected"); return undefined; }
        let socket;
        let timer;
        let cancelled = false;
        let attempts = 0;
        let resyncing = false;
        let highWater = null;
        let highWaterRunId = null;
        const connect = () => {
            if (cancelled || resyncing) return;
            const cursor = checkpoint.current;
            const query = new URLSearchParams();
            if (cursor.sequence) query.set("since", String(cursor.sequence));
            if (cursor.runId) query.set("runId", cursor.runId);
            const address = bonsaiRuntimeSocketUrl() + (query.size ? `?${query}` : "");
            try { socket = new WebSocket(address); }
            catch (error) { callbacks.current.onConnectionIssue?.(String(error)); retry(); return; }
            setConnection("connecting");
            socket.onopen = () => { attempts = 0; setConnection("connected"); };
            socket.onmessage = async ({ data }) => {
                let message;
                try { message = JSON.parse(data); }
                catch { return; }
                if (cancelled || socket.readyState !== WebSocket.OPEN) return;
                if (message.type === "hello") {
                    // A hello is a high-water mark, not an acknowledged event.
                    highWater = Number.isSafeInteger(message.sequence) ? message.sequence : highWater;
                    highWaterRunId = message.runId || highWaterRunId;
                    if (checkpoint.current.runId && message.runId && message.runId !== checkpoint.current.runId) {
                        await resync("Server run changed");
                    }
                    return;
                }
                if (message.type === "resync_required") { await resync("WebSocket event history expired or overflowed"); return; }
                if (resyncing) return;
                if (checkpoint.current.runId && message.runId && message.runId !== checkpoint.current.runId) {
                    highWater = Number.isSafeInteger(message.sequence) ? Math.max(0, message.sequence - 1) : highWater;
                    highWaterRunId = message.runId;
                    await resync("Server run changed"); return;
                }
                const number = message.sequence;
                if (Number.isSafeInteger(number)) {
                    if (number <= checkpoint.current.sequence && (!message.runId || message.runId === checkpoint.current.runId)) return;
                    if (checkpoint.current.sequence && number !== checkpoint.current.sequence + 1) {
                        await resync("Missing runtime event sequence"); return;
                    }
                }
                // Only advance the cursor AFTER the consumer has processed this event.
                try { callbacks.current.onEvent?.(message); }
                catch (error) { callbacks.current.onConnectionIssue?.(`Event handler failed: ${String(error)}`); return; }
                checkpoint.current = {
                    runId: message.runId || checkpoint.current.runId,
                    sequence: Number.isSafeInteger(number) ? number : checkpoint.current.sequence,
                };
            };
            socket.onerror = () => callbacks.current.onConnectionIssue?.("Could not connect to Bonsai runtime WebSocket on port 8080.");
            socket.onclose = () => { if (!cancelled && !resyncing) retry(); };
        };
        const retry = () => {
            if (cancelled || resyncing) return;
            setConnection("reconnecting");
            window.clearTimeout(timer);
            timer = window.setTimeout(connect, Math.min(8000, 450 * 2 ** Math.min(attempts++, 5)));
        };
        const resync = async (reason) => {
            if (resyncing || cancelled) return;
            resyncing = true;
            setConnection("resyncing");
            socket?.close();
            callbacks.current.onConnectionIssue?.(`${reason}. Recovering from snapshot; earlier event history is incomplete.`);
            // Anchor at the hello high-water mark BEFORE fetching the snapshot,
            // so no event published during HTTP acquisition is skipped on replay.
            const anchor = highWater;
            try {
                const baseline = await getWebCommanderEventSnapshot();
                if (cancelled) return;
                callbacks.current.onResync?.(baseline);
                checkpoint.current = { runId: highWaterRunId, sequence: Number.isSafeInteger(anchor) ? anchor : 0 };
            } catch (error) {
                if (cancelled) return;
                callbacks.current.onConnectionIssue?.(`Snapshot recovery failed: ${String(error)}`);
                callbacks.current.onResync?.(null);
                checkpoint.current = { runId: highWaterRunId, sequence: Number.isSafeInteger(anchor) ? anchor : 0 };
            } finally {
                resyncing = false;
                if (!cancelled) retry();
            }
        };
        connect();
        return () => { cancelled = true; window.clearTimeout(timer); socket?.close(); };
    }, [enabled, generation]);
    return { connection, reconnectNow };
}
