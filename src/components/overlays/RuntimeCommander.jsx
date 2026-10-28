import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertCircle, FiAlertTriangle, FiChevronDown, FiChevronLeft, FiChevronRight, FiFolder, FiPause, FiPlay, FiRefreshCw, FiSettings, FiSquare, FiX, FiSkipBack, FiSkipForward, FiRadio } from "react-icons/fi";
import { isTauri, openFile } from "../../tauri-client.js";
import { classifyWebCommanderMessages, getWebCommanderSnapshot, getWebCommanderStatus, loadWebCommander, requestWebCommander } from "../../utils/webCommander.js";
import { loadRuntimeConfiguration, saveRuntimeConfiguration } from "../../utils/editorPreferences.js";
import { Button, InlineFeedback, TextInput } from "../ui/index.js";
import { useBonsaiRuntimeSocket } from "../../hooks/editor/useBonsaiRuntimeSocket.js";
import { runtimePayload } from "../../utils/runtimeEventFrames.js";
import { matchesLoadedInitial, initialWorkflowStateIds } from "../../utils/runtimeWorkflowIdentity.js";
import { getManualRuntimeEvents } from "../../utils/runtimeLiveValues.js";
import { isRootTerminalState } from "../../utils/runtimeParallelContexts.js";
import { runtimeConnectionNeedsStatusRefresh, shouldReplaceControlStatusBaseline, shouldRetryControlStatusSnapshot } from "../../utils/runtimeControlRecovery.js";
import { runtimeControlAvailability, runtimeBadgeStatus } from "../../utils/runtimeControlAvailability.js";

export default function RuntimeCommander({
    isOpen,
    onClose,
    workflowTab,
    workflowFingerprint,
    getTabSnapshot,
    getTabsSnapshot,
    getActiveDocumentIdentity,
    onExecutionUpdate,
    onRuntimeEvent,
    onRuntimeReset,
    onLogLoadRequested,
    onRuntimeGap,
    onRuntimeBackendRestart,
    onRuntimeBaseline,
    runtimeTimeline,
    selectedRuntimeFrame,
    onRuntimeSeek,
    onRuntimeLive,
    onRuntimeStarted,
    unresolvedStates = [],
    runtimeParallelViews = [],
    runtimeActiveSubMachines = [],
    onOpenRuntimeSubMachine,
    behaviorDirectories = [],
}) {
    const [configuration, setConfiguration] = useState(loadRuntimeConfiguration);
    const [forceConfigure, setForceConfigure] = useState(false);
    const [eventName, setEventName] = useState("");
    const [snapshot, setSnapshot] = useState(null);
    const [loadedWorkflow, setLoadedWorkflow] = useState(null);
    const [loadMessages, setLoadMessages] = useState([]);
    const [loadSucceeded, setLoadSucceeded] = useState(null);
    const [isFollowing, setIsFollowing] = useState(false);
    const [followCamera, setFollowCamera] = useState(true);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const [timelineExpanded, setTimelineExpanded] = useState(false);
    const [diagnosticsPopupOpen, setDiagnosticsPopupOpen] = useState(false);
    const [autoOpenSubMachines, setAutoOpenSubMachines] = useState(false);
    const [autoExpandCompounds, setAutoExpandCompounds] = useState(false);
    const [autoExpandParallels, setAutoExpandParallels] = useState(false);
    const [automaticEnabled, setAutomaticEnabled] = useState(true);
    const [error, setError] = useState("");
    const [statusError, setStatusError] = useState("");
    // Verified by the HTTP status endpoint, not the runtime-event WebSocket.
    const [httpConnected, setHttpConnected] = useState(null);
    const [runtimeNotice, setRuntimeNotice] = useState("");
    const [busyAction, setBusyAction] = useState("");
    const [isRefreshing, setIsRefreshing] = useState(false);
    // A WebSocket reconnect does not imply that the HTTP control server is ready.
    // Retry only while recovering; never poll a healthy running state machine.
    const [statusRecoveryPending, setStatusRecoveryPending] = useState(false);
    const previousEventConnectionRef = useRef(null);
    const [isBrowsing, setIsBrowsing] = useState(false);
    const [previouslyOpen, setPreviouslyOpen] = useState(isOpen);
    const configurationRef = useRef(null);
    const panelRef = useRef(null);
    const [optionsPosition, setOptionsPosition] = useState(null);
    const openerRef = useRef(null);
    const ownerRef = useRef(null);
    const operationRef = useRef(null);
    const readRef = useRef(null);
    const browseRef = useRef(null);
    const loadedWorkflowRef = useRef(null);
    const followingRef = useRef(false);
    const followCameraRef = useRef(true);
    const displayOptionsRef = useRef({ autoOpenSubMachines: false, autoExpandCompounds: false, autoExpandParallels: false });
    const observedRunningRef = useRef(false);
    const terminalStopRequestedRef = useRef(false);
    const [terminalStopPending, setTerminalStopPending] = useState(false);
    const acceptedRunRef = useRef(false);
    const eventVersionRef = useRef(0);
    const eventRef = useRef(null);
    const id = useId();
    const shouldObserve = isOpen || isFollowing;

    const updateConfiguration = (path) => {
        setConfiguration(path);
        saveRuntimeConfiguration(path);
    };

    useLayoutEffect(() => {
        if (!isOpen) return;
        if (!panelRef.current?.contains(document.activeElement)) openerRef.current = document.activeElement;
        panelRef.current?.focus();
        return () => {
            if (browseRef.current) browseRef.current.cancelled = true;
            browseRef.current = null;
        };
    }, [isOpen]);

    // The options panel is portaled to <body> to stay above all editor ledges.
    // Position it using the actual Run window, rather than viewport constants.
    useLayoutEffect(() => {
        if (!isOpen || !optionsOpen) return;
        const positionOptions = () => {
            const rect = panelRef.current?.getBoundingClientRect();
            if (!rect) return;
            const margin = 10;
            const width = Math.min(460, window.innerWidth - 24);
            const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
            setOptionsPosition({
                left: `${left}px`,
                right: "auto",
                top: "auto",
                bottom: `${Math.max(12, window.innerHeight - rect.top + margin)}px`,
                maxHeight: `${Math.max(100, rect.top - margin - 12)}px`,
                width: `${width}px`,
            });
        };
        positionOptions();
        window.addEventListener("resize", positionOptions);
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(positionOptions) : null;
        if (panelRef.current) observer?.observe(panelRef.current);
        return () => { window.removeEventListener("resize", positionOptions); observer?.disconnect(); };
    }, [isOpen, optionsOpen]);

    // The drawer is a sibling portal, so Escape must work regardless of whether
    // keyboard focus is inside the Run window or the options drawer.
    useEffect(() => {
        if (!optionsOpen || !isOpen) return;
        const onEscape = (event) => {
            if (event.key !== "Escape" || diagnosticsPopupOpen) return;
            event.preventDefault();
            event.stopPropagation();
            setOptionsOpen(false);
        };
        document.addEventListener("keydown", onEscape, true);
        return () => document.removeEventListener("keydown", onEscape, true);
    }, [isOpen, optionsOpen, diagnosticsPopupOpen]);

    const publishOptions = (changes) => {
        displayOptionsRef.current = { ...displayOptionsRef.current, ...changes };
        onExecutionUpdate?.({ workflow: loadedWorkflowRef.current, snapshot,
            following: followingRef.current, followCamera: followCameraRef.current,
            ...displayOptionsRef.current });
    };

    useLayoutEffect(() => {
        if (!shouldObserve) return;
        const owner = {};
        ownerRef.current = owner;
        return () => {
            if (ownerRef.current === owner) ownerRef.current = null;
            readRef.current?.controller.abort();
            readRef.current = null;
            operationRef.current?.controller.abort();
            operationRef.current = null;
            if (browseRef.current) browseRef.current.cancelled = true;
            browseRef.current = null;
        };
    }, [shouldObserve]);

    const refreshStatus = async () => {
        const owner = ownerRef.current;
        if (!owner) return;
        readRef.current?.controller.abort();
        const request = { controller: new AbortController() };
        readRef.current = request;
        setIsRefreshing(true);
        const startedAtVersion = eventVersionRef.current;
        try {
            const next = await getWebCommanderSnapshot(request.controller.signal);
            if (ownerRef.current !== owner || readRef.current !== request) return;
            setSnapshot((current) => {
                // Preserve newer live-event state, but never retain an obsolete
                // or missing control baseline just because events arrived during
                // the HTTP request (common immediately after reconnecting).
                if (!shouldReplaceControlStatusBaseline(startedAtVersion, eventVersionRef.current, current)) return current;
                return { ...next, statusStale: false };
            });
            setStatusError("");
            setHttpConnected(true);
            setStatusRecoveryPending(shouldRetryControlStatusSnapshot(next));
            if (followingRef.current && ["RUNNING", "PAUSED"].includes(next.status)) observedRunningRef.current = true;
            else if (followingRef.current && observedRunningRef.current) {
                followingRef.current = false;
                observedRunningRef.current = false;
                setIsFollowing(false);
            }
            onExecutionUpdate?.({ workflow: loadedWorkflowRef.current, snapshot: next,
                following: followingRef.current, followCamera: followCameraRef.current,
                ...displayOptionsRef.current, event: eventRef.current });
            eventRef.current = null;
        } catch (reason) {
            if (ownerRef.current !== owner || readRef.current !== request || request.controller.signal.aborted) return;
            let status;
            try {
                status = await getWebCommanderStatus(request.controller.signal);
            } catch {
                // A stale status must not enable controls when the status endpoint also fails.
            }
            if (ownerRef.current !== owner || readRef.current !== request || request.controller.signal.aborted) return;
            onExecutionUpdate?.({ workflow: loadedWorkflowRef.current, snapshot: null, following: false,
                followCamera: followCameraRef.current, ...displayOptionsRef.current });
            if (status) {
                setHttpConnected(true);
                setSnapshot({ status, currentStates: [], stateIds: [], transitions: [], checkedAt: Date.now(), detailsUnavailable: true, statusStale: false });
                setStatusError(`Engine status is available, but state/transition details could not be read. ${String(reason?.message || reason)}`);
                setStatusRecoveryPending(true);
            } else {
                setHttpConnected(false);
                setSnapshot((previous) => previous ? { ...previous, statusStale: true } : null);
                setStatusError(`Could not get engine status. ${String(reason?.message || reason)} Check that WebCommander is running on localhost:8080.`);
                setStatusRecoveryPending(true);
            }
        } finally {
            if (readRef.current === request) {
                readRef.current = null;
                if (ownerRef.current === owner) setIsRefreshing(false);
            }
        }
    };

    // Snapshot is an initial/resync baseline only. No 500ms polling during execution.
    useEffect(() => {
        if (shouldObserve) void refreshStatus();
    // A newly opened session needs one baseline; live values arrive over WebSocket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shouldObserve]);

    // The HTTP API may recover after the WebSocket handshake. A missed first
    // status request must not leave Load/Start disabled until manual refresh.
    useEffect(() => {
        if (!shouldObserve || !statusRecoveryPending) return undefined;
        const timer = setInterval(() => {
            if (!readRef.current && !operationRef.current) void refreshStatus();
        }, 2000);
        return () => clearInterval(timer);
    // The interval must not restart on each status update or runtime event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shouldObserve, statusRecoveryPending]);

    const { connection: eventConnection, address: eventSocketAddress,
        diagnostic: eventSocketDiagnostic, hasConnected: eventSocketEverConnected, reconnectNow } = useBonsaiRuntimeSocket({
        // Listen even when the floating Run panel is closed: external runs
        // must still reach the timeline and follow-focus projection.
        enabled: true,
        onEvent: (message) => {
            const payload = runtimePayload(message);
            eventVersionRef.current += 1;
            if (message.type === "status" && payload.value === "LOADING") {
                setRuntimeNotice("");
                acceptedRunRef.current = false;
                followingRef.current = false;
                setIsFollowing(false);
                loadedWorkflowRef.current = null;
                setLoadedWorkflow(null);
                onRuntimeReset?.();
            }
            if (message.type === "started") {
                const currentWorkflow = loadedWorkflowRef.current || getTabSnapshot?.() || workflowTab;
                if (!matchesLoadedInitial(currentWorkflow, payload.initial)) {
                    const expected = initialWorkflowStateIds(currentWorkflow);
                    setRuntimeNotice(`Ignored run: backend started at ${String(payload.initial || "(missing)")}.
                        Loaded workflow initial: ${expected.join(" / ") || "not available"}.`);
                    acceptedRunRef.current = false;
                    followingRef.current = false;
                    setIsFollowing(false);
                    onRuntimeReset?.();
                    setSnapshot((current) => ({ ...current, status: "RUNNING", currentStates: [], checkedAt: Date.now() }));
                    return;
                }
                acceptedRunRef.current = true;
                setRuntimeNotice("");
                if (!loadedWorkflowRef.current) {
                    const tabsSnapshot = getTabsSnapshot?.() || [currentWorkflow];
                    loadedWorkflowRef.current = currentWorkflow;
                    setLoadedWorkflow(currentWorkflow);
                    onExecutionUpdate?.({ workflow: currentWorkflow, tabsSnapshot,
                        following: true, action: "load", ...displayOptionsRef.current });
                }
                followingRef.current = true;
                setIsFollowing(true);
                onRuntimeStarted?.();
                setSnapshot((current) => ({ ...current, status: "RUNNING", statusStale: false, currentStates: [],
                    transitions: [], checkedAt: Date.now() }));
            }
            if (message.type === "status") {
                if (acceptedRunRef.current && ["RUNNING", "PAUSED"].includes(payload.value))
                    observedRunningRef.current = true;
                const reportedStatus = String(payload.value || "UNKNOWN");
                setSnapshot((current) => ({ ...current, status: reportedStatus, statusStale: false,
                    currentStates: current?.currentStates || [], checkedAt: Date.now() }));
                setStatusRecoveryPending(reportedStatus === "LOADING");
            } else if (acceptedRunRef.current && (message.type === "state_entered" || message.type === "state_exited")) {
                setSnapshot((current) => {
                    const states = new Set(current?.currentStates || []);
                    if (message.type === "state_entered") states.add(payload.state);
                    else states.delete(payload.state);
                    return { ...current, status: current?.status || "RUNNING", currentStates: [...states],
                        checkedAt: Date.now() };
                });
            } else if (message.type === "stopped" || message.type === "completed") {
                if (acceptedRunRef.current) {
                    const state = message.type === "stopped" ? "STOPPED"
                        : payload.outcome === "failure" ? "FAILED" : "COMPLETED";
                    setSnapshot((current) => ({ ...current, status: state, currentStates: [], checkedAt: Date.now() }));
                }
                terminalStopRequestedRef.current = false;
                setTerminalStopPending(false);
                followingRef.current = false;
                setIsFollowing(false);
            }
            // Initial attachment to an in-progress run is deliberately ignored.
            // After reconnecting, a previously observed run remains accepted.
            if (acceptedRunRef.current) {
                onRuntimeEvent?.(message);
            }
            if (message.type === "stopped" || message.type === "completed") acceptedRunRef.current = false;
        },
        onGap: (reason) => {
            if (acceptedRunRef.current) {
                onRuntimeGap?.();
                setSnapshot((current) => ({ ...current, currentStates: [], statusStale: true }));
            }
            setStatusError(reason);
            setStatusRecoveryPending(true);
        },
        onConnectionLost: () => {
            setStatusRecoveryPending(true);
            if (acceptedRunRef.current) {
                onRuntimeGap?.();
                setSnapshot((current) => ({ ...current, currentStates: [], statusStale: true }));
            }
        },
        onRestart: () => {
            acceptedRunRef.current = false;
            followingRef.current = false;
            setIsFollowing(false);
            loadedWorkflowRef.current = null;
            setLoadedWorkflow(null);
            setSnapshot(null);
            setHttpConnected(null);
            setLoadSucceeded(null);
            setLoadMessages([]);
            setStatusRecoveryPending(true);
            setRuntimeNotice("Backend restarted; waiting for the next matching run.");
            onRuntimeBackendRestart?.();
        },
        onConnectionIssue: (reason) => setStatusError(reason),
    });

    useEffect(() => {
        const previousConnection = previousEventConnectionRef.current;
        previousEventConnectionRef.current = eventConnection;
        if (eventConnection !== "connected") return;
        setStatusError("");
        if (runtimeConnectionNeedsStatusRefresh(previousConnection, eventConnection)) {
            // The WebSocket can reconnect without changing shouldObserve, so
            // the initial-only status effect above would otherwise never run.
            setStatusRecoveryPending(true);
            if (shouldObserve) void refreshStatus();
        }
    // Reconnect resynchronizes control status, not the historical event stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventConnection, shouldObserve]);

    // Loading a different top-level workflow in the editor invalidates the
    // previously loaded runtime graph; visiting a nested tab does not.
    useEffect(() => {
        if (!workflowTab || workflowTab.parentTabId) return;
        if (!loadedWorkflowRef.current || loadedWorkflowRef.current.id === workflowTab.id) return;
        loadedWorkflowRef.current = null;
        acceptedRunRef.current = false;
        followingRef.current = false;
        setLoadedWorkflow(null);
        setIsFollowing(false);
    }, [workflowTab?.id, workflowTab?.parentTabId]);

    const close = () => {
        if (operationRef.current) return;
        if (browseRef.current) browseRef.current.cancelled = true;
        if (panelRef.current?.contains(document.activeElement) && openerRef.current?.isConnected) {
            openerRef.current.focus();
        }
        onClose();
    };

    const chooseConfiguration = async () => {
        if (operationRef.current || browseRef.current) return;
        const owner = ownerRef.current;
        const request = { cancelled: false };
        browseRef.current = request;
        setIsBrowsing(true);
        try {
            const path = await openFile("Choose Bonsai configuration");
            if (ownerRef.current !== owner || request.cancelled || !path) return;
            updateConfiguration(path);
            setError("");
        } catch (reason) {
            if (ownerRef.current === owner && !request.cancelled) {
                setError(`Could not choose configuration. ${String(reason?.message || reason)} Enter a path or try Browse again.`);
            }
        } finally {
            if (browseRef.current === request) {
                browseRef.current = null;
                setIsBrowsing(false);
            }
        }
    };

    const execute = async (action, enabled) => {
        if (operationRef.current || browseRef.current || !ownerRef.current) return;
        const owner = ownerRef.current;
        const operation = { controller: new AbortController() };
        operationRef.current = operation;
        readRef.current?.controller.abort();
        readRef.current = null;
        setIsRefreshing(false);
        setBusyAction(action);
        setError("");
        let sent = false;
        try {
            if (action === "load") {
                terminalStopRequestedRef.current = false;
                setTerminalStopPending(false);
                const pathToConfig = configuration.trim();
                if (!pathToConfig) throw new Error("Choose a Bonsai configuration first.");
                const identity = getActiveDocumentIdentity();
                const workflow = getTabSnapshot();
                if (!workflow) throw new Error("Open a state machine first.");
                const tabsSnapshot = getTabsSnapshot?.() ?? [workflow];
                if (getActiveDocumentIdentity() !== identity) {
                    throw new Error("The open workflow changed before loading. Nothing was sent to the engine.");
                }
                if (ownerRef.current !== owner) return;
                const includeMapping = Object.fromEntries(behaviorDirectories
                    .filter((directory) => directory.key?.trim() && directory.path?.trim())
                    .map((directory) => [directory.key.trim(), (directory.resolvedPath || directory.path).trim()]));
                onLogLoadRequested?.();
                sent = true;
                followingRef.current = false;
                observedRunningRef.current = false;
                eventRef.current = null;
                loadedWorkflowRef.current = null;
                setLoadedWorkflow(null);
                setIsFollowing(false);
                setLoadMessages([]);
                setLoadSucceeded(null);
                setDiagnosticsPopupOpen(false);
                setTimelineExpanded(false);
                setAutomaticEnabled(true);
                setEventName("");
                setSnapshot(null);
                setStatusError("");
                acceptedRunRef.current = false;
                onRuntimeReset?.();
                onExecutionUpdate?.({ workflow: null, snapshot: null, following: false,
                    followCamera: followCameraRef.current, ...displayOptionsRef.current });
                const result = await loadWebCommander({ pathToConfig, pathToTask: workflow.filePath || "", includeMapping, forceConfigure }, operation.controller.signal, workflow);
                if (ownerRef.current !== owner) return;
                // Even a failed configuration response proves the HTTP service responded.
                setHttpConnected(true);
                // Loading a workflow always restores the default: automatic events ON.
                // Apply it to the engine as well as to the toggle (no stale previous run state).
                if (result.success) {
                    await requestWebCommander("stop_events", { method: "POST", body: "true",
                        signal: operation.controller.signal });
                    if (ownerRef.current !== owner) return;
                }
                const loaded = { ...workflow, generation: workflow.documentGeneration, configuration: pathToConfig, includeMapping };
                loadedWorkflowRef.current = loaded;
                setLoadedWorkflow(loaded);
                onExecutionUpdate?.({ workflow: loaded, tabsSnapshot, snapshot: null, following: false,
                    followCamera: followCameraRef.current, ...displayOptionsRef.current, action: "load" });
                // Loading Results are sourced exclusively from the HTTP load response.
                setLoadMessages(result.messages);
                setLoadSucceeded(result.success);
                const severity = classifyWebCommanderMessages(result.messages);
                if (!result.success || severity.warnings.length || severity.errors.length) setDiagnosticsPopupOpen(true);

            } else {
                if (action === "start") {
                    const current = getTabSnapshot();
                    if (!loadedWorkflow || current?.id !== loadedWorkflow.id
                        || current.documentGeneration !== loadedWorkflow.generation
                        || current.fingerprint !== loadedWorkflow.fingerprint) {
                        throw new Error("Load the current version of the open state machine before starting it.");
                    }
                }
                // stop_events forwards its Boolean directly to enableAutomaticEvents.
                const body = action === "fire_event" ? selectedEventName
                    : action === "stop_events" ? JSON.stringify(enabled) : undefined;
                if (action === "fire_event" && !body) throw new Error("Enter a transition event first.");
                if (action === "start") {
                    setTimelineExpanded(false);
                    terminalStopRequestedRef.current = false;
                    setTerminalStopPending(false);
                    onRuntimeReset?.();
                }
                sent = true;
                await requestWebCommander(action, { method: "POST", body, signal: operation.controller.signal });
                if (ownerRef.current !== owner) return;
                if (action === "stop_events") setAutomaticEnabled(enabled);
                if (action === "resume") setSnapshot((current) => ({ ...current, status: "RUNNING", statusStale: false }));
                if ((action === "start" || action === "resume") && loadedWorkflowRef.current) {
                    followingRef.current = true;
                    setIsFollowing(true);
                    if (action === "start") onRuntimeStarted?.();
                    onExecutionUpdate?.({ workflow: loadedWorkflowRef.current, snapshot: null, following: true,
                        followCamera: followCameraRef.current, ...displayOptionsRef.current, action });
                }
                if (action === "fire_event") eventRef.current = { name: body, sentAt: Date.now() };
                if (action === "stop") {
                    followingRef.current = false;
                    observedRunningRef.current = false;
                    setIsFollowing(false);
                    onExecutionUpdate?.({ workflow: null, snapshot: null, following: false,
                        followCamera: followCameraRef.current, ...displayOptionsRef.current });
                }

            }
            if (ownerRef.current === owner) await refreshStatus();
        } catch (reason) {
            if (ownerRef.current === owner) {
                const message = `${String(reason?.message || reason)}${sent ? " A request may have reached the engine. Refresh status before retrying." : ""}`;
                setError(message);
                if (action === "load") {
                    setLoadSucceeded(false);
                    setLoadMessages([`Error: ${message}`]);
                    setDiagnosticsPopupOpen(true);
                }
                if (sent) await refreshStatus();
            }
        } finally {
            if (operationRef.current === operation) {
                operationRef.current = null;
                if (ownerRef.current === owner) setBusyAction("");
            }
        }
    };

    if (previouslyOpen !== isOpen) {
        setPreviouslyOpen(isOpen);
        setIsBrowsing(false);
        if (!isFollowing) {
            setBusyAction("");
            setIsRefreshing(false);
            setSnapshot(null);
        }
    }
    // A terminal event is published before the automatic stop request. Waiting
    // for any in-flight start/load request to settle avoids dropping the stop.
    useEffect(() => {
        if (!terminalStopRequestedRef.current || busyAction || !loadedWorkflowRef.current) return;
        if (!["RUNNING", "PAUSED"].includes(snapshot?.status)) return;
        terminalStopRequestedRef.current = false;
        setTerminalStopPending(false);
        void execute("stop");
    // execute is intentionally recreated with current request/status state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [busyAction, snapshot?.status, terminalStopPending]);

    // The live engine's active state is authoritative, even with auto events off.
    // Never offer exit tokens from a manually scrubbed historical snapshot.
    const currentStates = snapshot?.currentStates || [];
    const manualEvents = getManualRuntimeEvents(loadedWorkflow, currentStates);
    const selectedEventName = manualEvents.some((entry) => entry.value === eventName)
        ? eventName : (manualEvents[0]?.value || "");

    if (!isOpen) return null;
    const busy = Boolean(busyAction);
    const ready = snapshot && !snapshot.statusStale && !["UNKNOWN", "LOADING"].includes(snapshot.status);
    const canControl = !busy && !isBrowsing && ready;
    const loadedCurrent = loadedWorkflow && workflowTab?.id === loadedWorkflow.id
        && workflowTab.documentGeneration === loadedWorkflow.generation
        && workflowFingerprint === loadedWorkflow.fingerprint;
    const availability = runtimeControlAvailability({
        status: snapshot?.status ?? null, statusStale: Boolean(snapshot?.statusStale),
        loadedCurrent: Boolean(loadedCurrent), configuration, busy, browsing: isBrowsing,
        eventConnection, refreshing: isRefreshing,
    });
    const canLoad = availability.canLoad;
    const canStart = availability.canStart;
    const reconnectControls = () => {
        setRuntimeNotice("");
        setStatusRecoveryPending(true);
        reconnectNow();
        if (shouldObserve) void refreshStatus();
    };
    const diagnostics = classifyWebCommanderMessages(loadMessages);
    const totalIssues = diagnostics.warnings.length + diagnostics.errors.length + diagnostics.diagnostics.length;
    const { label: statusLabel, tone: statusTone } = runtimeBadgeStatus({
        configuration,
        httpConnected,
        engineStatus: snapshot?.status,
        loadSucceeded,
        loading: busyAction === "load",
    });

    return createPortal(
        <>
            <section ref={panelRef} tabIndex={-1} role="region" aria-label="Run state machine" data-editor-shortcut-scope
                aria-busy={busy} className="runtime-commander-dialog nodrag nopan"
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") {
                        if (diagnosticsPopupOpen) setDiagnosticsPopupOpen(false);
                        else if (optionsOpen) setOptionsOpen(false);
                        else close();
                    }
                }}>
                {optionsOpen && createPortal(<div className="runtime-commander-drawer nodrag nopan" id={`${id}-options`}
                    style={optionsPosition || undefined} data-editor-shortcut-scope onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Escape") setOptionsOpen(false);
                    }}>
                    <div className="runtime-commander-drawer-header">
                        <strong><FiSettings aria-hidden="true" /> Run options</strong>
                        <button type="button" className="runtime-commander-icon-button" onClick={() => setOptionsOpen(false)}
                            aria-label="Close options"><FiX /></button>
                    </div>
                    <div className="runtime-commander-drawer-body">
                        <section className="runtime-commander-section">
                            <label className="runtime-commander-field">
                                <span>Configuration file</span>
                                <div className="runtime-commander-path-row">
                                    <TextInput ref={configurationRef} value={configuration} spellCheck={false}
                                        placeholder="/path/to/bonsai-config.xml" disabled={busy}
                                        onChange={(event) => {
                                            if (browseRef.current) browseRef.current.cancelled = true;
                                            updateConfiguration(event.target.value);
                                        }} />
                                    {isTauri() && <Button leadingIcon={<FiFolder />} onClick={chooseConfiguration}
                                        disabled={busy || isBrowsing}>Browse</Button>}
                                </div>
                            </label>
                            <label className="runtime-commander-switch">
                                <input type="checkbox" checked={forceConfigure} disabled={busy}
                                    onChange={(event) => setForceConfigure(event.target.checked)} />
                                <span>Force configuration reload</span>
                            </label>
                            {loadedWorkflow && !loadedCurrent &&
                                <InlineFeedback tone="warning">The open workflow has changed. Load the current version before Start.</InlineFeedback>}
                            {!["RUNNING", "PAUSED"].includes(snapshot?.status) ? null :
                                <p className="runtime-commander-note">Stop execution before loading another workflow.</p>}
                        </section>
                        <section className="runtime-commander-section runtime-loading-results-section">
                            <button type="button" className="runtime-commander-results-toggle"
                                onClick={() => setDiagnosticsPopupOpen(true)} title="Open the last loading results">
                                <span>Loading results</span>
                                {totalIssues > 0 && <span className="runtime-commander-count">{totalIssues}</span>}
                                <FiChevronRight aria-hidden="true" />
                            </button>
                        </section>
                        <section className="runtime-commander-section">
                            <h4>Live visualization</h4>
                            <div className="runtime-commander-choice" role="group" aria-label="Live navigation mode">
                                <button type="button" className={!followCamera ? "selected" : ""} aria-pressed={!followCamera}
                                    onClick={() => { setFollowCamera(false); followCameraRef.current = false; publishOptions({}); }}>
                                    Highlight only
                                </button>
                                <button type="button" className={followCamera ? "selected" : ""} aria-pressed={followCamera}
                                    onClick={() => { setFollowCamera(true); followCameraRef.current = true; publishOptions({}); }}>
                                    Follow focus
                                </button>
                            </div>
                            <div className="runtime-commander-toggle-stack" role="group" aria-label="Automatic navigation and expansion">
                                <button type="button" className="runtime-commander-toggle" aria-pressed={autoOpenSubMachines}
                                    onClick={() => { const next = !autoOpenSubMachines; setAutoOpenSubMachines(next); publishOptions({ autoOpenSubMachines: next }); }}>
                                    <span>Open sub-state machines</span><span className="runtime-commander-toggle-indicator">{autoOpenSubMachines ? "On" : "Off"}</span>
                                </button>
                                <button type="button" className="runtime-commander-toggle" aria-pressed={autoExpandCompounds}
                                    onClick={() => { const next = !autoExpandCompounds; setAutoExpandCompounds(next); publishOptions({ autoExpandCompounds: next }); }}>
                                    <span>Expand compounds</span><span className="runtime-commander-toggle-indicator">{autoExpandCompounds ? "On" : "Off"}</span>
                                </button>
                                <button type="button" className="runtime-commander-toggle" aria-pressed={autoExpandParallels}
                                    onClick={() => { const next = !autoExpandParallels; setAutoExpandParallels(next); publishOptions({ autoExpandParallels: next }); }}>
                                    <span>Expand parallels</span><span className="runtime-commander-toggle-indicator">{autoExpandParallels ? "On" : "Off"}</span>
                                </button>
                            </div>
                        </section>

                    </div>
                </div>, document.body)}
                <div className="runtime-commander-main">
                    <div className="runtime-commander-main-header">
                        <div className="runtime-log-file-info">
                            <strong>Run state machine</strong>
                            <span title={loadedWorkflow?.filePath || workflowTab?.filePath || ""}>
                                {loadedWorkflow?.fileName || workflowTab?.fileName || workflowTab?.title || "No workflow open"}
                            </span>
                        </div>
                        <span className={`runtime-commander-status-pill ${statusTone}`} role="status" aria-live="polite">
                            <span className="runtime-commander-status-dot" />{statusLabel}
                        </span>
                        {totalIssues > 0 && <button type="button" className="runtime-commander-issue-button"
                            title="View loading diagnostics" onClick={() => setDiagnosticsPopupOpen(true)}>
                            <FiAlertTriangle /> {totalIssues}
                        </button>}
                        <button type="button" className="runtime-commander-icon-button" aria-label="Close run panel"
                            title="Close run panel" disabled={busy} onClick={close}><FiX /></button>
                    </div>
                    {(runtimeNotice || (eventConnection !== "connected" && eventSocketDiagnostic)) &&
                        <div className="runtime-event-stream-state" role="status">
                            {runtimeNotice && <p className="runtime-event-stream-warning">{runtimeNotice}</p>}
                            {eventConnection !== "connected" && eventSocketDiagnostic &&
                                <p className="runtime-event-stream-warning" role="alert">{eventSocketDiagnostic}</p>}
                        </div>}
                    {runtimeTimeline?.frames?.length > 0 && <div className="runtime-event-timeline" aria-label="Runtime event timeline">
                        <button type="button" className="runtime-event-timeline-toggle"
                            aria-expanded={timelineExpanded} aria-controls={`${id}-timeline-content`}
                            onClick={() => setTimelineExpanded((value) => !value)}>
                            {timelineExpanded ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}
                            <strong>Timeline</strong>
                            <span>Snapshot {runtimeTimeline.index + 1} / {runtimeTimeline.frames.length}</span>
                        </button>
                        {timelineExpanded && <div id={`${id}-timeline-content`} className="runtime-event-timeline-content">
                            <div className="runtime-event-timeline-header">
                                <strong>{selectedRuntimeFrame?.kind === "state"
                                    ? String(selectedRuntimeFrame.state || "Skill").split(".").pop().replace(/#1$/, "")
                                    : selectedRuntimeFrame?.transition
                                        ? `${String(selectedRuntimeFrame.transition.source || "?").split(".").pop().replace(/#1$/, "")} → ${String(selectedRuntimeFrame.transition.target || "?").split(".").pop().replace(/#1$/, "")}`
                                        : "Transition"}</strong>
                            </div>
                            <input type="range" min="0" max={Math.max(0, runtimeTimeline.frames.length - 1)}
                                value={Math.max(0, runtimeTimeline.index)}
                                onChange={(event) => onRuntimeSeek?.(Number(event.target.value))}
                                aria-label="Select runtime snapshot" />
                            <div className="runtime-event-timeline-navigation">
                                <button type="button" disabled={runtimeTimeline.index <= 0}
                                    onClick={() => onRuntimeSeek?.(runtimeTimeline.index - 1)}><FiSkipBack /> Previous</button>
                                <button type="button" aria-pressed={runtimeTimeline.watching}
                                    onClick={onRuntimeLive}><FiRadio /> Live</button>
                                <button type="button" disabled={runtimeTimeline.index >= runtimeTimeline.frames.length - 1}
                                    onClick={() => onRuntimeSeek?.(runtimeTimeline.index + 1)}>Next <FiSkipForward /></button>
                            </div>
                            {(runtimeTimeline.hasGap || runtimeTimeline.truncated) && <p className="runtime-event-timeline-alert">
                                {runtimeTimeline.hasGap ? "Incomplete history · active-state set may be partially unknown." : "Local event history limit reached."}
                            </p>}
                        </div>}
                    </div>}
                    <div className="runtime-log-controls runtime-commander-toolbar" aria-label="Execution controls">
                        <div className="runtime-commander-primary-actions">
                            <button type="button" onClick={() => void execute("load")}
                                disabled={!canLoad} title={availability.loadReason || "Load configuration and current state machine"}>
                                <FiFolder /><span>Load</span></button>
                            <button type="button" className="runtime-log-play-button" onClick={() => void execute("start")}
                                disabled={!canStart}
                                title={availability.startReason || "Start"}><FiPlay /><span>Start</span></button>
                        </div>
                        <button type="button" onClick={() => void execute("pause")}
                            disabled={!canControl || snapshot?.status !== "RUNNING"} title="Pause"><FiPause /><span>Pause</span></button>
                        <button type="button" onClick={() => void execute("resume")}
                            disabled={!canControl || snapshot?.status !== "PAUSED"} title="Resume"><FiPlay /><span>Resume</span></button>
                        <button type="button" onClick={() => void execute("stop")}
                            disabled={!canControl || !["RUNNING", "PAUSED"].includes(snapshot?.status)} title="Stop"><FiSquare /><span>Stop</span></button>
                        <button type="button" className="runtime-commander-auto-events" aria-pressed={automaticEnabled === true}
                            disabled={!canControl || !loadedWorkflow} onClick={() => void execute("stop_events", automaticEnabled !== true)}
                            title={`Automatic transition events ${automaticEnabled ? "enabled" : "disabled"}`}>
                            <FiRadio /><span>Auto events</span><span className="runtime-commander-auto-state">{automaticEnabled ? "On" : "Off"}</span>
                        </button>
                    </div>
                    {(eventConnection !== "connected" || snapshot?.statusStale || statusError) &&
                        <div className="runtime-commander-connection-help" role="status" aria-live="polite">
                            <div className="runtime-commander-connection-message">
                                {eventConnection !== "connected" &&
                                    <span>Runtime WebSocket {eventConnection === "connecting" ? "connecting" : "disconnected"}; automatic retry active.</span>}
                                {statusError && <span title={statusError}>Status check failed; verify the HTTP server on port 8080.</span>}
                            </div>
                            {(eventConnection !== "connected" || snapshot?.statusStale || statusError) &&
                                <button type="button" onClick={reconnectControls} disabled={busy || isRefreshing}
                                    title="Reconnect runtime WebSocket and refresh engine status">
                                    <FiRefreshCw aria-hidden="true" /> Reconnect
                                </button>}
                        </div>}
                    <form className="runtime-commander-manual-event" aria-label="Send a transition event"
                        onSubmit={(event) => { event.preventDefault(); if (canControl && selectedEventName) void execute("fire_event"); }}>
                        <label htmlFor={`${id}-manual-event`}>Send event</label>
                        <select id={`${id}-manual-event`} className="runtime-commander-event-select"
                            value={selectedEventName} onChange={(event) => setEventName(event.target.value)}
                            disabled={!canControl || !manualEvents.length}
                            aria-label="Events of the currently active skill">
                            {!manualEvents.length && <option value="">No events available for active skill</option>}
                            {manualEvents.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                        </select>
                        <button type="submit" className="runtime-commander-send-button"
                            disabled={!canControl || !selectedEventName}>Send</button>
                    </form>
                    {(busy || error || (statusError && !optionsOpen)) &&
                        <div className="runtime-commander-footer" role="status">
                            {busy ? "Waiting for the engine..." : error || (statusError && !optionsOpen)}
                        </div>}
                </div>
                <button type="button" className="runtime-commander-ledge" aria-expanded={optionsOpen}
                    aria-controls={`${id}-options`} title={optionsOpen ? "Close run options" : "Open run options"}
                    onClick={() => setOptionsOpen(!optionsOpen)}>
                    <FiSettings aria-hidden="true" />
                    {optionsOpen ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
                    <span>Options</span>
                </button>
            </section>
            {diagnosticsPopupOpen && <div className="runtime-commander-popup-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget) setDiagnosticsPopupOpen(false);
            }}>
                <section className="runtime-commander-popup" role="dialog" aria-modal="true"
                    aria-labelledby={`${id}-diagnostics-title`} data-editor-shortcut-scope
                    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setDiagnosticsPopupOpen(false); }}>
                    <header>
                        <div><h3 id={`${id}-diagnostics-title`}>Loading results</h3>
                            <p>{loadSucceeded ? "The workflow was loaded with the following messages." : "The load reported issues."}</p></div>
                        <button type="button" className="runtime-commander-icon-button" autoFocus
                            aria-label="Close loading results" onClick={() => setDiagnosticsPopupOpen(false)}><FiX /></button>
                    </header>
                    <div className="runtime-commander-popup-body"><LoadMessages diagnostics={diagnostics} /></div>
                    <footer><Button onClick={() => setDiagnosticsPopupOpen(false)}>Close</Button></footer>
                </section>
            </div>}
        </>,
        // Keep the Run controller inside the canvas, rather than allowing a
        // window-fixed overlay to cover the bottom-docked Run Logs panel.
        document.getElementById("workflow-tab-panel") || document.body,
    );
}

function LoadMessages({ diagnostics }) {
    return <div className="runtime-commander-diagnostics">
        {diagnostics.errors.length > 0 && <div className="runtime-commander-diagnostic error">
            <strong><FiAlertCircle /> Errors ({diagnostics.errors.length})</strong>
            <ul>{diagnostics.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
        </div>}
        {diagnostics.warnings.length > 0 && <div className="runtime-commander-diagnostic warning">
            <strong><FiAlertTriangle /> Warnings ({diagnostics.warnings.length})</strong>
            <ul>{diagnostics.warnings.map((message, index) => <li key={index}>{message}</li>)}</ul>
        </div>}
        {diagnostics.diagnostics.length > 0 && <div className="runtime-commander-diagnostic info">
            <strong>Other messages ({diagnostics.diagnostics.length})</strong>
            <ul>{diagnostics.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul>
        </div>}
    </div>;
}
