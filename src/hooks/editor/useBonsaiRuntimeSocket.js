import { useEffect, useRef, useState } from "react";
import { runtimeSocketAddresses } from "../../utils/runtimeSocketAddresses.js";

/** Live-only SCXML event stream: no replay cursor or snapshot endpoint exists. */
export function bonsaiRuntimeSocketUrl() {
    return runtimeSocketAddresses(window.location.hostname)[0];
}

export function useBonsaiRuntimeSocket({ enabled, onEvent, onGap, onRestart, onConnectionLost, onConnectionIssue }) {
    const callbacks = useRef({});
    callbacks.current = { onEvent, onGap, onRestart, onConnectionLost, onConnectionIssue };
    const lastSequence = useRef(null);
    const [connection, setConnection] = useState("disconnected");
    const [address, setAddress] = useState("");
    const [diagnostic, setDiagnostic] = useState("");
    const [hasConnected, setHasConnected] = useState(false);
    const [generation, reconnect] = useState(0);
    const reconnectNow = () => reconnect((value) => value + 1);

    useEffect(() => {
        if (!enabled) {
            setConnection("disconnected");
            setAddress("");
            setDiagnostic("");
            lastSequence.current = null;
            return undefined;
        }
        const endpoints = runtimeSocketAddresses(window.location.hostname);
        let socket;
        let timer;
        let cancelled = false;
        let endpointIndex = 0;
        let cycles = 0;
        let wasConnected = false;
        const report = (message) => {
            if (cancelled) return;
            setDiagnostic(message);
            callbacks.current.onConnectionIssue?.(message);
        };
        const retry = () => {
            if (cancelled) return;
            const switchedHost = endpointIndex < endpoints.length - 1;
            endpointIndex = (endpointIndex + 1) % endpoints.length;
            if (!switchedHost) cycles += 1;
            setConnection("reconnecting");
            clearTimeout(timer);
            // Try the alternate loopback hostname promptly before backing off.
            timer = setTimeout(connect, switchedHost ? 250 : Math.min(8000, 450 * 2 ** Math.min(cycles, 5)));
        };
        const connect = () => {
            if (cancelled) return;
            const target = endpoints[endpointIndex];
            setAddress(target);
            let opened = false;
            let hadError = false;
            try { socket = new WebSocket(target); }
            catch (error) {
                report(`Cannot create a WebSocket to ${target}: ${String(error)}`);
                retry();
                return;
            }
            setConnection(wasConnected || cycles > 0 || endpointIndex > 0 ? "reconnecting" : "connecting");
            socket.onopen = () => {
                if (cancelled) return;
                opened = true;
                wasConnected = true;
                cycles = 0;
                setHasConnected(true);
                setDiagnostic("");
                setConnection("connected");
            };
            socket.onmessage = ({ data }) => {
                let message;
                try { message = JSON.parse(data); } catch { return; }
                if (cancelled || message?.type === "hello") return;
                if (message.type === "resync_required") {
                    callbacks.current.onGap?.("Backend reports lost events; history cannot be recovered.");
                    return;
                }
                const sequence = message.sequence;
                if (Number.isSafeInteger(sequence)) {
                    const last = lastSequence.current;
                    if (last !== null && sequence < last) {
                        callbacks.current.onRestart?.();
                    } else if (last !== null && sequence === last) return;
                    else if (last !== null && sequence > last + 1) {
                        callbacks.current.onGap?.(`Missing SCXML event sequences ${last + 1}–${sequence - 1}.`);
                    }
                    lastSequence.current = sequence;
                }
                try { callbacks.current.onEvent?.(message); }
                catch (error) { callbacks.current.onConnectionIssue?.(`Runtime event processing failed: ${String(error)}`); }
            };
            socket.onerror = () => {
                if (cancelled) return;
                hadError = true;
                // Browsers deliberately hide the handshake's HTTP response here.
                report(`WebSocket error connecting to ${target}. Check the WebView console for a rejected handshake, mixed-content, or Content Security Policy error.`);
            };
            socket.onclose = (event) => {
                if (cancelled) return;
                if (opened) callbacks.current.onConnectionLost?.();
                const detail = `WebSocket ${opened ? "closed" : "failed before opening"} at ${target}`
                    + ` (code ${event.code}${event.reason ? `, reason: ${event.reason}` : ""}${event.wasClean ? ", clean" : ", unclean"}).`;
                // A close code of 1006 cannot identify why a browser handshake failed.
                report(`${detail}${hadError ? " Browser console may contain the underlying cause." : ""}`);
                retry();
            };
        };
        connect();
        return () => { cancelled = true; clearTimeout(timer); socket?.close(); };
    }, [enabled, generation]);
    return { connection, address, diagnostic, hasConnected, reconnectNow };
}
