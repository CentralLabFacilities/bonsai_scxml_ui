import { useCallback, useEffect, useRef, useState } from 'react';
import { appendRunLogs, parseRunLogMessage, RUN_LOG_URL, runLogRetryDelay } from '../../utils/runLogData.js';

/** Owns its WebSocket and buffer: logging must never update the editor document. */
export function useRunLogSocket(session) {
    const [logs, setLogs] = useState([]);
    const [status, setStatus] = useState('idle');
    const [connectionIssue, setConnectionIssue] = useState('');
    const pendingRef = useRef([]);
    const flushTimerRef = useRef(null);
    const sequenceRef = useRef(0);

    const flush = useCallback(() => {
        flushTimerRef.current = null;
        const batch = pendingRef.current;
        if (!batch.length) return;
        pendingRef.current = [];
        setLogs((previous) => appendRunLogs(previous, batch));
    }, []);

    const clear = useCallback(() => {
        pendingRef.current = [];
        if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        setLogs([]);
    }, []);

    useEffect(() => {
        if (!session) return;
        let cancelled = false;
        let socket = null;
        let reconnectTimer = null;
        let attempt = 0;
        // The caller remounts this hook for every Load attempt, resetting all history.
        function connect() {
            if (cancelled) return;
            setStatus(attempt ? 'reconnecting' : 'connecting');
            try { socket = new WebSocket(RUN_LOG_URL); }
            catch (error) { scheduleReconnect(String(error)); return; }
            socket.onopen = () => {
                if (cancelled) return;
                attempt = 0;
                setConnectionIssue('');
                setStatus('connected');
            };
            socket.onmessage = ({ data }) => {
                if (cancelled) return;
                const value = parseRunLogMessage(data);
                if (!value) return;
                pendingRef.current.push({ ...value, id: ++sequenceRef.current });
                if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flush, 80);
            };
            socket.onerror = () => {
                if (!cancelled) setConnectionIssue(`Unable to reach ${RUN_LOG_URL}`);
            };
            socket.onclose = () => {
                if (!cancelled) scheduleReconnect();
            };
        }
        function scheduleReconnect(reason = '') {
            if (cancelled || reconnectTimer !== null) return;
            if (reason) setConnectionIssue(reason);
            setStatus('reconnecting');
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, runLogRetryDelay(attempt++));
        }
        connect();
        return () => {
            cancelled = true;
            clearTimeout(reconnectTimer);
            if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
            pendingRef.current = [];
            if (socket) {
                socket.onclose = null;
                socket.onmessage = null;
                socket.onerror = null;
                socket.onopen = null;
                socket.close();
            }
        };
    }, [session, flush]);

    return { logs, status, connectionIssue, clear };
}
