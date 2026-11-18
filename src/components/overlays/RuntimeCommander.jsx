import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FiAlertCircle,
  FiAlertTriangle,
  FiChevronDown,
  FiChevronLeft,
  FiChevronRight,
  FiFolder,
  FiPlay,
  FiRefreshCw,
  FiSettings,
  FiSquare,
  FiX,
  FiSkipBack,
  FiSkipForward,
  FiRadio,
} from "react-icons/fi";
import { isTauri, openFile } from "../../tauri-client.js";
import {
  classifyWebCommanderMessages,
  getWebCommanderSnapshot,
  getWebCommanderStatus,
  loadWebCommander,
  requestWebCommander,
} from "../../utils/webCommander.js";
import { loadRuntimeConfiguration, saveRuntimeConfiguration } from "../../utils/editorPreferences.js";
import { Button, InlineFeedback, TextInput } from "../ui/index.js";
import { useBonsaiRuntimeSocket } from "../../hooks/editor/useBonsaiRuntimeSocket.js";
import { emittedRuntimeEventName, runtimePayload } from "../../utils/runtimeEventFrames.js";
import { matchesLoadedInitial, initialWorkflowStateIds } from "../../utils/runtimeWorkflowIdentity.js";
import { getManualRuntimeEvents } from "../../utils/runtimeLiveValues.js";
import {
  runtimeConnectionNeedsStatusRefresh,
  shouldReplaceControlStatusBaseline,
  shouldRetryControlStatusSnapshot,
} from "../../utils/runtimeControlRecovery.js";
import { runtimeControlAvailability, runtimeBadgeStatus } from "../../utils/runtimeControlAvailability.js";
import { findDuplicateSubmachineStateName } from "../../utils/stateNameValidation.js";

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
  runtimeTimeline,
  selectedRuntimeFrame,
  onRuntimeSeek,
  onRuntimeLive,
  onRuntimeFocusSnapshot,
  focusCameraRequest,
  runtimeParallelViews = [],
  onRuntimeStarted,
  onBeforeRuntimeStart,
  behaviorDirectories = [],
}) {
  const [configuration, setConfiguration] = useState(loadRuntimeConfiguration);
  const [forceConfigure, setForceConfigure] = useState(false);
  const [eventName, setEventName] = useState("");
  const [lastSentEvent, setLastSentEvent] = useState("");
  const [pendingSkillEvent, setPendingSkillEvent] = useState("");
  const [eventMenuOpen, setEventMenuOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [loadedWorkflow, setLoadedWorkflow] = useState(null);
  const [loadMessages, setLoadMessages] = useState([]);
  const [loadSucceeded, setLoadSucceeded] = useState(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followCamera, setFollowCamera] = useState(true);
  const [parallelFocus, setParallelFocus] = useState(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [diagnosticsPopupOpen, setDiagnosticsPopupOpen] = useState(false);
  const [autoOpenSubMachines, setAutoOpenSubMachines] = useState(false);
  const [autoExpandCompounds, setAutoExpandCompounds] = useState(false);
  const [autoExpandParallels, setAutoExpandParallels] = useState(false);
  const [automaticEnabled, setAutomaticEnabled] = useState(true);
  const manualModeRef = useRef(false);
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
  const eventPickerRef = useRef(null);
  const [optionsPosition, setOptionsPosition] = useState(null);
  const openerRef = useRef(null);
  const ownerRef = useRef(null);
  const operationRef = useRef(null);
  const readRef = useRef(null);
  const browseRef = useRef(null);
  const loadedWorkflowRef = useRef(null);
  const followingRef = useRef(false);
  const followCameraRef = useRef(true);
  // Double-clicking a snapshot in Run Assignments also activates Follow focus here.
  useEffect(() => {
    if (!focusCameraRequest) return;
    setFollowCamera(true);
    followCameraRef.current = true;
  }, [focusCameraRequest]);
  const displayOptionsRef = useRef({
    autoOpenSubMachines: false,
    autoExpandCompounds: false,
    autoExpandParallels: false,
    parallelFocus: null,
  });
  const observedRunningRef = useRef(false);
  const terminalStopRequestedRef = useRef(false);
  // A stopped engine may publish its execution stop before control status is ready.
  // During this brief interval, poll only /status (never expensive state lists).
  const stopReadyPendingRef = useRef(false);
  const [terminalStopPending, setTerminalStopPending] = useState(false);
  const acceptedRunRef = useRef(false);
  const eventVersionRef = useRef(0);
  const eventRef = useRef(null);
  const id = useId();
  // A hidden Run window must not cancel a pending load/start/stop operation.
  const shouldObserve = isOpen || isFollowing || Boolean(busyAction);

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
    return () => {
      window.removeEventListener("resize", positionOptions);
      observer?.disconnect();
    };
  }, [isOpen, optionsOpen]);

  // The native <option> popup is rendered by WebKitGTK and does not reliably
  // honor custom option colors. Use an in-app listbox so emitted events are
  // visibly orange both in the closed picker and inside its dropdown.
  useEffect(() => {
    if (!eventMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (!eventPickerRef.current?.contains(event.target)) setEventMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setEventMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [eventMenuOpen]);

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
    onExecutionUpdate?.({
      workflow: loadedWorkflowRef.current,
      snapshot,
      following: followingRef.current,
      followCamera: followCameraRef.current,
      ...displayOptionsRef.current,
    });
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
      const next = stopReadyPendingRef.current
        ? { status: await getWebCommanderStatus(request.controller.signal), currentStates: [], stateIds: [], transitions: [], checkedAt: Date.now() }
        : await getWebCommanderSnapshot(request.controller.signal);
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
      const retryStoppedStatus = stopReadyPendingRef.current && ["RUNNING", "PAUSED", "LOADING"].includes(next.status);
      stopReadyPendingRef.current = retryStoppedStatus;
      setStatusRecoveryPending(retryStoppedStatus || shouldRetryControlStatusSnapshot(next));
      if (followingRef.current && ["RUNNING", "PAUSED"].includes(next.status)) observedRunningRef.current = true;
      else if (followingRef.current && observedRunningRef.current) {
        followingRef.current = false;
        observedRunningRef.current = false;
        setIsFollowing(false);
      }
      onExecutionUpdate?.({
        workflow: loadedWorkflowRef.current,
        snapshot: next,
        following: followingRef.current,
        followCamera: followCameraRef.current,
        ...displayOptionsRef.current,
        event: eventRef.current,
      });
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
      onExecutionUpdate?.({
        workflow: loadedWorkflowRef.current,
        snapshot: null,
        following: false,
        followCamera: followCameraRef.current,
        ...displayOptionsRef.current,
      });
      if (status) {
        setHttpConnected(true);
        setSnapshot({
          status,
          currentStates: [],
          stateIds: [],
          transitions: [],
          checkedAt: Date.now(),
          detailsUnavailable: true,
          statusStale: false,
        });
        setStatusError(
          `Engine status is available, but state/transition details could not be read. ${String(reason?.message || reason)}`,
        );
        setStatusRecoveryPending(true);
      } else {
        setHttpConnected(false);
        setSnapshot((previous) => (previous ? { ...previous, statusStale: true } : null));
        setStatusError(
          `Could not get engine status. ${String(reason?.message || reason)} Check that WebCommander is running on localhost:8080.`,
        );
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

  const {
    connection: eventConnection,
    diagnostic: eventSocketDiagnostic,
    reconnectNow,
  } = useBonsaiRuntimeSocket({
    // Listen even when the floating Run panel is closed: external runs
    // must still reach the timeline and follow-focus projection.
    enabled: true,
    onEvent: (message) => {
      const payload = runtimePayload(message);
      eventVersionRef.current += 1;
      const emittedEvent = emittedRuntimeEventName(message);
      if (emittedEvent && manualModeRef.current && acceptedRunRef.current) {
        // This is the skill's *published* event, not a user-issued fire_event.
        setPendingSkillEvent(emittedEvent);
        setEventName(emittedEvent); // default Send selection, including nested skills
      }
      // Status notifications are not a user-requested Load. A nested SCXML
      // may initialize while its parent remains active, and even an unexpected
      // LOADING notification must not erase recorded snapshots. Explicit Load
      // and Start perform their own reset in runAction below.
      if (message.type === "status" && payload.value === "LOADING" && acceptedRunRef.current) return;
      if (message.type === "started") {
        // An already accepted run owns the stream. Another `started` can be
        // emitted for a nested SCXML: never treat it as a new top-level run,
        // even when its initial state happens to have the same name.
        if (acceptedRunRef.current) return;
        const currentWorkflow = loadedWorkflowRef.current || getTabSnapshot?.() || workflowTab;
        if (!matchesLoadedInitial(currentWorkflow, payload.initial)) {
          // A non-matching, unsolicited run must not erase historical data.
          const expected = initialWorkflowStateIds(currentWorkflow);
          setRuntimeNotice(`Ignored run: backend started at ${String(payload.initial || "(missing)")}.
                        Loaded workflow initial: ${expected.join(" / ") || "not available"}.`);
          acceptedRunRef.current = false;
          followingRef.current = false;
          setIsFollowing(false);
          setSnapshot((current) => ({ ...current, status: "RUNNING", currentStates: [], checkedAt: Date.now() }));
          return;
        }
        acceptedRunRef.current = true;
        setRuntimeNotice("");
        if (!loadedWorkflowRef.current) {
          const tabsSnapshot = getTabsSnapshot?.() || [currentWorkflow];
          loadedWorkflowRef.current = currentWorkflow;
          setLoadedWorkflow(currentWorkflow);
          onExecutionUpdate?.({
            workflow: currentWorkflow,
            tabsSnapshot,
            following: true,
            action: "load",
            ...displayOptionsRef.current,
          });
        }
        followingRef.current = true;
        setIsFollowing(true);
        onRuntimeStarted?.();
        setSnapshot((current) => ({
          ...current,
          status: "RUNNING",
          statusStale: false,
          currentStates: [],
          transitions: [],
          checkedAt: Date.now(),
        }));
      }
      if (message.type === "status") {
        if (acceptedRunRef.current && ["RUNNING", "PAUSED"].includes(payload.value)) observedRunningRef.current = true;
        const reportedStatus = String(payload.value || "UNKNOWN");
        setSnapshot((current) => ({
          ...current,
          status: reportedStatus,
          statusStale: false,
          currentStates: current?.currentStates || [],
          checkedAt: Date.now(),
        }));
        setStatusRecoveryPending(reportedStatus === "LOADING");
      } else if (acceptedRunRef.current && (message.type === "state_entered" || message.type === "state_exited")) {
        setSnapshot((current) => {
          const states = new Set(current?.currentStates || []);
          if (message.type === "state_entered") states.add(payload.state);
          else states.delete(payload.state);
          return {
            ...current,
            status: current?.status || "RUNNING",
            currentStates: [...states],
            checkedAt: Date.now(),
          };
        });
      } else if (message.type === "stopped" || message.type === "completed") {
        if (acceptedRunRef.current) {
          const state = message.type === "stopped" ? "STOPPED" : payload.outcome === "failure" ? "FAILED" : "COMPLETED";
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
        // Keep manual-mode context with this event so the timeline can stop
        // only the emitting skill's ring without changing SCXML active states.
        onRuntimeEvent?.(emittedEvent ? { ...message, manualMode: manualModeRef.current } : message);
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
      // A sequence regression may indicate a backend restart, but the event
      // stream has no replay API. Keep the existing snapshots for inspection
      // and mark the gap instead of silently erasing the whole history.
      onRuntimeGap?.();
      acceptedRunRef.current = false;
      followingRef.current = false;
      setIsFollowing(false);
      setSnapshot((current) => current ? { ...current, statusStale: true } : current);
      setStatusRecoveryPending(true);
      setRuntimeNotice("SCXML event sequence restarted; previous snapshots are retained, but the history may be incomplete.");
    },
    onConnectionIssue: (reason) => setStatusError(reason),
  });

  useEffect(() => {
    const previousConnection = previousEventConnectionRef.current;
    previousEventConnectionRef.current = eventConnection;
    if (eventConnection !== "connected") return;
    // Clear status error when WebSocket reconnects.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // The loaded workflow is the engine's run identity, not the currently
  // selected editor tab. Opening a sub-SM (or another editor document) while
  // running must not detach the WebSocket listener from that run.

  const close = () => {
    // Hiding the window is never the same as stopping or cancelling the engine.
    // The command remains in flight, and can be inspected again on reopening.
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
        setError(
          `Could not choose configuration. ${String(reason?.message || reason)} Enter a path or try Browse again.`,
        );
      }
    } finally {
      if (browseRef.current === request) {
        browseRef.current = null;
        setIsBrowsing(false);
      }
    }
  };
  // The live engine's active state is authoritative, even with auto events off.
  // Never offer exit tokens from a manually scrubbed historical snapshot.
  const currentStates = snapshot?.currentStates || [];
  const manualMode = !automaticEnabled;
  const configuredManualEvents = getManualRuntimeEvents(loadedWorkflow, currentStates);
  // An observed send is authoritative even when its child skill is not in
  // the root document's static event list or the state has already exited.
  const manualEvents = manualMode && pendingSkillEvent && !configuredManualEvents.some((entry) => entry.value === pendingSkillEvent)
    ? [{ value: pendingSkillEvent, label: pendingSkillEvent }, ...configuredManualEvents]
    : configuredManualEvents;
  const selectedEventName = manualEvents.some((entry) => entry.value === eventName)
    ? eventName
    : pendingSkillEvent && manualMode ? pendingSkillEvent : manualEvents[0]?.value || "";
  // Keep the last sent event visible at the top of the selector, even when
  // the skill has already transitioned and that event is no longer available.
  const lastSentEventIsAvailable = manualEvents.some((entry) => entry.value === lastSentEvent);
  const highlightedEvent = manualMode ? pendingSkillEvent || lastSentEvent : "";
  const orderedManualEvents = highlightedEvent && manualEvents.some((entry) => entry.value === highlightedEvent)
    ? [...manualEvents.filter((entry) => entry.value === highlightedEvent),
        ...manualEvents.filter((entry) => entry.value !== highlightedEvent)]
    : manualEvents;

  const execute = async (action, enabled) => {
    if (operationRef.current || browseRef.current || !ownerRef.current) return;
    const owner = ownerRef.current;
    const operation = { controller: new AbortController() };
    operationRef.current = operation;
    readRef.current?.controller.abort();
    readRef.current = null;
    setIsRefreshing(false);
    setBusyAction(action);
    setEventMenuOpen(false);
    setError("");
    let sent = false;
    try {
      if (action === "load") {
        terminalStopRequestedRef.current = false;
        setTerminalStopPending(false);
        stopReadyPendingRef.current = false;
        const pathToConfig = configuration.trim();
        if (!pathToConfig) throw new Error("Choose a Bonsai configuration first.");
        const identity = getActiveDocumentIdentity();
        const workflow = getTabSnapshot();
        if (!workflow) throw new Error("Open a state machine first.");
        const conflictingName = findDuplicateSubmachineStateName(workflow.nodes || []);
        if (conflictingName) {
          throw new Error(
            `Duplicate SCXML state name "${conflictingName}". Rename one sub-state machine before loading. Nothing was sent to the engine; Load remains available.`,
          );
        }
        const tabsSnapshot = getTabsSnapshot?.() ?? [workflow];
        if (getActiveDocumentIdentity() !== identity) {
          throw new Error("The open workflow changed before loading. Nothing was sent to the engine.");
        }
        if (ownerRef.current !== owner) return;
        const includeMapping = Object.fromEntries(
          behaviorDirectories
            .filter((directory) => directory.key?.trim() && directory.path?.trim())
            .map((directory) => [directory.key.trim(), (directory.resolvedPath || directory.path).trim()]),
        );
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
        setParallelFocus(null);
        displayOptionsRef.current.parallelFocus = null;
        setAutomaticEnabled(true);
        manualModeRef.current = false;
        setEventName("");
        setLastSentEvent("");
        setPendingSkillEvent("");
        setSnapshot(null);
        setStatusError("");
        acceptedRunRef.current = false;
        onRuntimeReset?.();
        onExecutionUpdate?.({
          workflow: null,
          snapshot: null,
          following: false,
          followCamera: followCameraRef.current,
          ...displayOptionsRef.current,
        });
        const result = await loadWebCommander(
          { pathToConfig, pathToTask: workflow.filePath || "", includeMapping, forceConfigure },
          operation.controller.signal,
          workflow,
        );
        if (ownerRef.current !== owner) return;
        // Even a failed configuration response proves the HTTP service responded.
        setHttpConnected(true);
        // Loading a workflow always restores the default: automatic events ON.
        // Apply it to the engine as well as to the toggle (no stale previous run state).
        if (result.success) {
          await requestWebCommander("stop_events", {
            method: "POST",
            body: "true",
            signal: operation.controller.signal,
          });
          if (ownerRef.current !== owner) return;
        }
        const loaded = {
          ...workflow,
          generation: workflow.documentGeneration,
          configuration: pathToConfig,
          includeMapping,
        };
        loadedWorkflowRef.current = loaded;
        setLoadedWorkflow(loaded);
        onExecutionUpdate?.({
          workflow: loaded,
          tabsSnapshot,
          snapshot: null,
          following: false,
          followCamera: followCameraRef.current,
          ...displayOptionsRef.current,
          action: "load",
        });
        // Loading Results are sourced exclusively from the HTTP load response.
        setLoadMessages(result.messages);
        setLoadSucceeded(result.success);
        const severity = classifyWebCommanderMessages(result.messages);
        if (!result.success || severity.warnings.length || severity.errors.length) setDiagnosticsPopupOpen(true);
      } else {
        if (action === "start") {
          const current = getTabSnapshot();
          if (
            !loadedWorkflow ||
            current?.id !== loadedWorkflow.id ||
            current.documentGeneration !== loadedWorkflow.generation ||
            current.fingerprint !== loadedWorkflow.fingerprint
          ) {
            throw new Error("Load the current version of the open state machine before starting it.");
          }
        }
        // stop_events forwards its Boolean directly to enableAutomaticEvents.
        const body =
          action === "fire_event" ? selectedEventName : action === "stop_events" ? JSON.stringify(enabled) : undefined;
        if (action === "fire_event" && !body) throw new Error("Enter a transition event first.");
        if (action === "start") {
          // A new run starts with whole-Parallel focus, not an old lane lock.
          setParallelFocus(null);
          displayOptionsRef.current.parallelFocus = null;
          stopReadyPendingRef.current = false;
          setTimelineExpanded(false);
          setLastSentEvent("");
          setPendingSkillEvent("");
          terminalStopRequestedRef.current = false;
          setTerminalStopPending(false);
          onRuntimeReset?.();
          // Complete the all-slot baseline before the engine can enter its
          // initial state. Missing Memory WebSupport does not block Start.
          await onBeforeRuntimeStart?.();
          if (ownerRef.current !== owner || operation.controller.signal.aborted) return;
        }
        sent = true;
        const controlSentAt = performance.now();
        await requestWebCommander(action, { method: "POST", body, signal: operation.controller.signal });
        if (action === "stop" && performance.now() - controlSentAt > 1500) {
          console.info(`[Bonsai Runtime] Stop HTTP acknowledgement took ${Math.round(performance.now() - controlSentAt)} ms after the request was sent.`);
        }
        if (ownerRef.current !== owner) return;
        if (action === "stop_events") {
          manualModeRef.current = !enabled;
          setAutomaticEnabled(enabled);
          if (enabled) setPendingSkillEvent("");
        }
        // The engine may not publish a live status event while paused.
        // A successful control acknowledgment must still expose the
        // matching Resume/Pause action immediately; the HTTP snapshot
        // below reconciles this optimistic control status.
        if (action === "pause" || action === "resume") {
          const expected = action === "pause" ? "PAUSED" : "RUNNING";
          setSnapshot((current) => ({ ...current, status: expected, statusStale: false }));
        }
        if ((action === "start" || action === "resume") && loadedWorkflowRef.current) {
          followingRef.current = true;
          setIsFollowing(true);
          if (action === "start") onRuntimeStarted?.();
          onExecutionUpdate?.({
            workflow: loadedWorkflowRef.current,
            snapshot: null,
            following: true,
            followCamera: followCameraRef.current,
            ...displayOptionsRef.current,
            action,
          });
        }
        if (action === "fire_event") {
          eventRef.current = { name: body, sentAt: Date.now() };
          setLastSentEvent(body);
          if (body === pendingSkillEvent) setPendingSkillEvent("");
        }
        if (action === "stop") {
          setPendingSkillEvent("");
          followingRef.current = false;
          observedRunningRef.current = false;
          setIsFollowing(false);
          onExecutionUpdate?.({
            workflow: null,
            snapshot: null,
            following: false,
            followCamera: followCameraRef.current,
            ...displayOptionsRef.current,
          });
        }
      }
      if (ownerRef.current === owner) {
        if (action === "stop") {
          // Stop is already acknowledged. The states/all_states/transitions
          // requests do not affect readiness, and can be slow after shutdown.
          const status = await getWebCommanderStatus(operation.controller.signal);
          if (ownerRef.current === owner) {
            setSnapshot({ status, currentStates: [], stateIds: [], transitions: [], checkedAt: Date.now(), statusStale: false });
            setHttpConnected(true);
            setStatusError("");
            const retryStoppedStatus = ["RUNNING", "PAUSED", "LOADING"].includes(status);
            stopReadyPendingRef.current = retryStoppedStatus;
            setStatusRecoveryPending(retryStoppedStatus);
          }
        } else {
          await refreshStatus();
        }
      }
    } catch (reason) {
      if (ownerRef.current === owner) {
        const message = `${String(reason?.message || reason)}${sent ? " A request may have reached the engine. Refresh status before retrying." : ""}`;
        setError(message);
        if (action === "load") {
          setLoadSucceeded(false);
          setLoadMessages([`Error: ${message}`]);
          setDiagnosticsPopupOpen(true);
        }
        if (sent) {
          if (action === "stop") stopReadyPendingRef.current = true;
          await refreshStatus();
        }
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
    if (!isFollowing && !operationRef.current) {
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
    // Reset pending stop when the engine is no longer running.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTerminalStopPending(false);
    void execute("stop");
    // execute is intentionally recreated with current request/status state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyAction, snapshot?.status, terminalStopPending]);

  if (!isOpen) return null;
  const busy = Boolean(busyAction);
  const ready = snapshot && !snapshot.statusStale && !["UNKNOWN", "LOADING"].includes(snapshot.status);
  const canControl = !busy && !isBrowsing && ready;
  const loadedCurrent =
    loadedWorkflow &&
    workflowTab?.id === loadedWorkflow.id &&
    workflowTab.documentGeneration === loadedWorkflow.generation &&
    workflowFingerprint === loadedWorkflow.fingerprint;
  const availability = runtimeControlAvailability({
    status: snapshot?.status ?? null,
    statusStale: Boolean(snapshot?.statusStale),
    loadedCurrent: Boolean(loadedCurrent),
    configuration,
    busy,
    browsing: isBrowsing,
    eventConnection,
    refreshing: isRefreshing,
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
      <section
        ref={panelRef}
        tabIndex={-1}
        role="region"
        aria-label="Run state machine"
        data-editor-shortcut-scope
        aria-busy={busy}
        className="runtime-commander-dialog nodrag nopan"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            if (diagnosticsPopupOpen) setDiagnosticsPopupOpen(false);
            else if (optionsOpen) setOptionsOpen(false);
            else close();
          }
        }}
      >
        {optionsOpen &&
          createPortal(
            <div
              className="runtime-commander-drawer nodrag nopan"
              id={`${id}-options`}
              style={optionsPosition || undefined}
              data-editor-shortcut-scope
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") setOptionsOpen(false);
              }}
            >
              <div className="runtime-commander-drawer-header">
                <strong>
                  <FiSettings aria-hidden="true" /> Run options
                </strong>
                <button
                  type="button"
                  className="runtime-commander-icon-button"
                  onClick={() => setOptionsOpen(false)}
                  aria-label="Close options"
                >
                  <FiX />
                </button>
              </div>
              <div className="runtime-commander-drawer-body">
                <section className="runtime-commander-section">
                  <label className="runtime-commander-field">
                    <span>Configuration file</span>
                    <div className="runtime-commander-path-row">
                      <TextInput
                        ref={configurationRef}
                        value={configuration}
                        spellCheck={false}
                        placeholder="/path/to/bonsai-config.xml"
                        disabled={busy}
                        onChange={(event) => {
                          if (browseRef.current) browseRef.current.cancelled = true;
                          updateConfiguration(event.target.value);
                        }}
                      />
                      {isTauri() && (
                        <Button leadingIcon={<FiFolder />} onClick={chooseConfiguration} disabled={busy || isBrowsing}>
                          Browse
                        </Button>
                      )}
                    </div>
                  </label>
                  <label className="runtime-commander-switch">
                    <input
                      type="checkbox"
                      checked={forceConfigure}
                      disabled={busy}
                      onChange={(event) => setForceConfigure(event.target.checked)}
                    />
                    <span>Force configuration reload</span>
                  </label>
                  {loadedWorkflow && !loadedCurrent && (
                    <InlineFeedback tone="warning">
                      The open workflow has changed. Load the current version before Start.
                    </InlineFeedback>
                  )}
                  {!["RUNNING", "PAUSED"].includes(snapshot?.status) ? null : (
                    <p className="runtime-commander-note">Stop execution before loading another workflow.</p>
                  )}
                </section>
                <section className="runtime-commander-section runtime-loading-results-section">
                  <button
                    type="button"
                    className="runtime-commander-results-toggle"
                    onClick={() => setDiagnosticsPopupOpen(true)}
                    title="Open the last loading results"
                  >
                    <span>Loading results</span>
                    {totalIssues > 0 && <span className="runtime-commander-count">{totalIssues}</span>}
                    <FiChevronRight aria-hidden="true" />
                  </button>
                </section>
                <section className="runtime-commander-section">
                  <h4>Live visualization</h4>
                  <div className="runtime-commander-choice" role="group" aria-label="Live navigation mode">
                    <button
                      type="button"
                      className={!followCamera ? "selected" : ""}
                      aria-pressed={!followCamera}
                      onClick={() => {
                        setFollowCamera(false);
                        followCameraRef.current = false;
                        publishOptions({});
                      }}
                    >
                      Highlight only
                    </button>
                    <button
                      type="button"
                      className={followCamera ? "selected" : ""}
                      aria-pressed={followCamera}
                      onClick={() => {
                        setFollowCamera(true);
                        followCameraRef.current = true;
                        publishOptions({});
                      }}
                    >
                      Follow focus
                    </button>
                  </div>
                  {runtimeParallelViews.filter((view) => !view.exiting && view.lanes?.length > 1).map((view) => (
                    <label key={view.key} className="runtime-commander-parallel-focus">
                      <span>Follow in {view.node.data?.label || "Parallel"}</span>
                      <select
                        value={parallelFocus?.parallelKey === view.key ? parallelFocus.laneId : ""}
                        onChange={(event) => {
                          const selection = event.target.value
                            ? { parallelKey: view.key, laneId: event.target.value }
                            : null;
                          setParallelFocus(selection);
                          setFollowCamera(true);
                          followCameraRef.current = true;
                          publishOptions({ parallelFocus: selection });
                        }}
                      >
                        <option value="">Whole Parallel</option>
                        {view.lanes.filter((lane) => lane.id).map((lane, index) => (
                          <option key={lane.id} value={lane.id}>
                            {lane.name || `Lane ${index + 1}`}{lane.status === "completed" ? " (completed)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <div
                    className="runtime-commander-toggle-stack"
                    role="group"
                    aria-label="Automatic navigation and expansion"
                  >
                    <button
                      type="button"
                      className="runtime-commander-toggle"
                      aria-pressed={autoOpenSubMachines}
                      onClick={() => {
                        const next = !autoOpenSubMachines;
                        setAutoOpenSubMachines(next);
                        publishOptions({ autoOpenSubMachines: next });
                      }}
                    >
                      <span>Open sub-state machines</span>
                      <span className="runtime-commander-toggle-indicator">{autoOpenSubMachines ? "On" : "Off"}</span>
                    </button>
                    <button
                      type="button"
                      className="runtime-commander-toggle"
                      aria-pressed={autoExpandCompounds}
                      onClick={() => {
                        const next = !autoExpandCompounds;
                        setAutoExpandCompounds(next);
                        publishOptions({ autoExpandCompounds: next });
                      }}
                    >
                      <span>Expand compounds</span>
                      <span className="runtime-commander-toggle-indicator">{autoExpandCompounds ? "On" : "Off"}</span>
                    </button>
                    <button
                      type="button"
                      className="runtime-commander-toggle"
                      aria-pressed={autoExpandParallels}
                      onClick={() => {
                        const next = !autoExpandParallels;
                        setAutoExpandParallels(next);
                        publishOptions({ autoExpandParallels: next });
                      }}
                    >
                      <span>Expand parallels</span>
                      <span className="runtime-commander-toggle-indicator">{autoExpandParallels ? "On" : "Off"}</span>
                    </button>
                  </div>
                </section>
              </div>
            </div>,
            document.body,
          )}
        <div className="runtime-commander-main">
          <div className="runtime-commander-main-header">
            <div className="runtime-log-file-info">
              <strong>Run state machine</strong>
              <span title={loadedWorkflow?.filePath || workflowTab?.filePath || ""}>
                {loadedWorkflow?.fileName || workflowTab?.fileName || workflowTab?.title || "No workflow open"}
              </span>
            </div>
            {manualMode && (pendingSkillEvent || lastSentEvent) && (
              <span
                className="runtime-commander-last-sent"
                title={pendingSkillEvent ? `Skill emitted ${pendingSkillEvent}; awaiting manual dispatch` : `Last manually sent event: ${lastSentEvent}`}
              >
                {pendingSkillEvent ? "Ready:" : "Sent:"} <strong>{pendingSkillEvent || lastSentEvent}</strong>
              </span>
            )}
            <span className={`runtime-commander-status-pill ${statusTone}`} role="status" aria-live="polite">
              <span className="runtime-commander-status-dot" />
              {statusLabel}
            </span>
            {totalIssues > 0 && (
              <button
                type="button"
                className="runtime-commander-issue-button"
                title="View loading diagnostics"
                onClick={() => setDiagnosticsPopupOpen(true)}
              >
                <FiAlertTriangle /> {totalIssues}
              </button>
            )}
            <button
              type="button"
              className="runtime-commander-icon-button"
              aria-label="Close run panel"
              title="Close run panel"
              onClick={close}
            >
              <FiX />
            </button>
          </div>
          {(runtimeNotice || (eventConnection !== "connected" && eventSocketDiagnostic)) && (
            <div className="runtime-event-stream-state" role="status">
              {runtimeNotice && <p className="runtime-event-stream-warning">{runtimeNotice}</p>}
              {eventConnection !== "connected" && eventSocketDiagnostic && (
                <p className="runtime-event-stream-warning" role="alert">
                  {eventSocketDiagnostic}
                </p>
              )}
            </div>
          )}
          {runtimeTimeline?.frames?.length > 0 && (
            <div className="runtime-event-timeline" aria-label="Runtime event timeline">
              <button
                type="button"
                className="runtime-event-timeline-toggle"
                aria-expanded={timelineExpanded}
                aria-controls={`${id}-timeline-content`}
                onClick={() => setTimelineExpanded((value) => !value)}
              >
                {timelineExpanded ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}
                <strong>Timeline</strong>
                <span>
                  Snapshot {runtimeTimeline.index + 1} / {runtimeTimeline.frames.length}
                </span>
              </button>
              {timelineExpanded && (
                <div id={`${id}-timeline-content`} className="runtime-event-timeline-content">
                  <div
                    className="runtime-event-timeline-header"
                    onDoubleClick={() => onRuntimeFocusSnapshot?.(runtimeTimeline.index)}
                    title="Double-click to focus this snapshot and enable Follow focus"
                  >
                    <strong>
                      {selectedRuntimeFrame?.kind === "state"
                        ? String(selectedRuntimeFrame.state || "Skill")
                            .split(".")
                            .pop()
                            .replace(/#1$/, "")
                        : selectedRuntimeFrame?.transition
                          ? `${String(selectedRuntimeFrame.transition.source || "?")
                              .split(".")
                              .pop()
                              .replace(/#1$/, "")} → ${String(selectedRuntimeFrame.transition.target || "?")
                              .split(".")
                              .pop()
                              .replace(/#1$/, "")}`
                          : "Transition"}
                    </strong>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(0, runtimeTimeline.frames.length - 1)}
                    value={Math.max(0, runtimeTimeline.index)}
                    onChange={(event) => onRuntimeSeek?.(Number(event.target.value))}
                    aria-label="Select runtime snapshot"
                    onDoubleClick={() => onRuntimeFocusSnapshot?.(runtimeTimeline.index)}
                  />
                  <div className="runtime-event-timeline-navigation">
                    <button
                      type="button"
                      disabled={runtimeTimeline.index <= 0}
                      onClick={() => onRuntimeSeek?.(runtimeTimeline.index - 1)}
                    >
                      <FiSkipBack /> Previous
                    </button>
                    <button type="button" aria-pressed={runtimeTimeline.watching} onClick={onRuntimeLive}>
                      <FiRadio /> Live
                    </button>
                    <button
                      type="button"
                      disabled={runtimeTimeline.index >= runtimeTimeline.frames.length - 1}
                      onClick={() => onRuntimeSeek?.(runtimeTimeline.index + 1)}
                    >
                      Next <FiSkipForward />
                    </button>
                  </div>
                  {(runtimeTimeline.hasGap || runtimeTimeline.truncated) && (
                    <p className="runtime-event-timeline-alert">
                      {runtimeTimeline.hasGap
                        ? "Incomplete history · active-state set may be partially unknown."
                        : "Local event history limit reached."}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="runtime-log-controls runtime-commander-toolbar" aria-label="Execution controls">
            <div className="runtime-commander-primary-actions">
              <button
                type="button"
                onClick={() => void execute("load")}
                disabled={!canLoad}
                title={availability.loadReason || "Load configuration and current state machine"}
              >
                <FiFolder />
                <span>Load</span>
              </button>
              <button
                type="button"
                className="runtime-log-play-button"
                onClick={() => void execute("start")}
                disabled={!canStart}
                title={availability.startReason || "Start"}
              >
                <FiPlay />
                <span>Start</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => void execute("stop")}
              disabled={!canControl || !["RUNNING", "PAUSED"].includes(snapshot?.status)}
              title="Stop"
            >
              <FiSquare />
              <span>Stop</span>
            </button>
            <button
              type="button"
              className="runtime-commander-manual-mode"
              aria-pressed={manualMode}
              disabled={!canControl || !loadedWorkflow}
              // stop_events sends the desired *automatic* state to the engine.
              // Turning Manual Events on sends false and disables automatic dispatch.
              onClick={() => void execute("stop_events", manualMode)}
              title={manualMode
                ? "Manual Events on: automatic transition events are disabled"
                : "Manual Events off: automatic transition events are enabled"}
            >
              <FiRadio />
              <span>Manual Events</span>
              <span className="runtime-commander-auto-state">{manualMode ? "On" : "Off"}</span>
            </button>
          </div>
          {(eventConnection !== "connected" || snapshot?.statusStale || statusError) && (
            <div className="runtime-commander-connection-help" role="status" aria-live="polite">
              <div className="runtime-commander-connection-message">
                {eventConnection !== "connected" && (
                  <span>
                    Runtime WebSocket {eventConnection === "connecting" ? "connecting" : "disconnected"}; automatic
                    retry active.
                  </span>
                )}
                {statusError && (
                  <span title={statusError}>Status check failed; verify the HTTP server on port 8080.</span>
                )}
              </div>
              {(eventConnection !== "connected" || snapshot?.statusStale || statusError) && (
                <button
                  type="button"
                  onClick={reconnectControls}
                  disabled={busy || isRefreshing}
                  title="Reconnect runtime WebSocket and refresh engine status"
                >
                  <FiRefreshCw aria-hidden="true" /> Reconnect
                </button>
              )}
            </div>
          )}
          <form
            className="runtime-commander-manual-event"
            aria-label="Send a transition event"
            onSubmit={(event) => {
              event.preventDefault();
              if (canControl && selectedEventName) void execute("fire_event");
            }}
          >
            <label htmlFor={`${id}-manual-event`}>Send event</label>
            <div className="runtime-commander-event-picker" ref={eventPickerRef}>
              <button
                type="button"
                id={`${id}-manual-event`}
                className={`runtime-commander-event-select${highlightedEvent && selectedEventName === highlightedEvent ? " runtime-commander-event-selected-sent" : ""}`}
                aria-label="Events of the currently active skill"
                aria-haspopup="listbox"
                aria-expanded={eventMenuOpen}
                aria-controls={`${id}-manual-event-options`}
                disabled={!canControl || !manualEvents.length}
                onClick={() => setEventMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  if (!manualEvents.length) return;
                  const index = orderedManualEvents.findIndex((entry) => entry.value === selectedEventName);
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  const next = (index + direction + orderedManualEvents.length) % orderedManualEvents.length;
                  setEventName(orderedManualEvents[next].value);
                  setEventMenuOpen(true);
                }}
              >
                <span>{selectedEventName || "No events available for active skill"}</span>
                {highlightedEvent && selectedEventName === highlightedEvent && (
                  <span className="runtime-commander-event-ready-label">{pendingSkillEvent ? "Ready" : "Sent"}</span>
                )}
                <FiChevronDown aria-hidden="true" />
              </button>
              {eventMenuOpen && manualEvents.length > 0 && (
                <div id={`${id}-manual-event-options`} role="listbox" aria-label="Available skill events" className="runtime-commander-event-options">
                  {manualMode && lastSentEvent && !lastSentEventIsAvailable && !pendingSkillEvent && (
                    <div role="option" aria-selected={false} className="runtime-commander-event-option runtime-commander-event-was-sent" aria-disabled="true">
                      Last sent: {lastSentEvent}
                    </div>
                  )}
                  {orderedManualEvents.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      role="option"
                      aria-selected={entry.value === selectedEventName}
                      className={`runtime-commander-event-option${highlightedEvent === entry.value ? " runtime-commander-event-was-sent" : ""}`}
                      onClick={() => { setEventName(entry.value); setEventMenuOpen(false); }}
                    >
                      <span>{entry.label}</span>
                      {highlightedEvent === entry.value && (
                        <span className="runtime-commander-event-ready-label">{pendingSkillEvent ? "Ready" : "Sent"}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="submit"
              className="runtime-commander-send-button"
              disabled={!canControl || !selectedEventName}
            >
              Send
            </button>
          </form>
          {(busy || error || (statusError && !optionsOpen)) && (
            <div className="runtime-commander-footer" role="status">
              {busy ? "Waiting for the engine..." : error || (statusError && !optionsOpen)}
            </div>
          )}
        </div>
        <button
          type="button"
          className="runtime-commander-ledge"
          aria-expanded={optionsOpen}
          aria-controls={`${id}-options`}
          title={optionsOpen ? "Close run options" : "Open run options"}
          onClick={() => setOptionsOpen(!optionsOpen)}
        >
          <FiSettings aria-hidden="true" />
          {optionsOpen ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
          <span>Options</span>
        </button>
      </section>
      {diagnosticsPopupOpen && (
        <div
          className="runtime-commander-popup-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDiagnosticsPopupOpen(false);
          }}
        >
          <section
            className="runtime-commander-popup"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-diagnostics-title`}
            data-editor-shortcut-scope
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setDiagnosticsPopupOpen(false);
            }}
          >
            <header>
              <div>
                <h3 id={`${id}-diagnostics-title`}>Loading results</h3>
                <p>
                  {loadSucceeded ? "The workflow was loaded with the following messages." : "The load reported issues."}
                </p>
              </div>
              <button
                type="button"
                className="runtime-commander-icon-button"
                autoFocus
                aria-label="Close loading results"
                onClick={() => setDiagnosticsPopupOpen(false)}
              >
                <FiX />
              </button>
            </header>
            <div className="runtime-commander-popup-body">
              <LoadMessages diagnostics={diagnostics} />
            </div>
            <footer>
              <Button onClick={() => setDiagnosticsPopupOpen(false)}>Close</Button>
            </footer>
          </section>
        </div>
      )}
    </>,
    // Keep the Run controller inside the canvas, rather than allowing a
    // window-fixed overlay to cover the bottom-docked Run Logs panel.
    document.getElementById("workflow-tab-panel") || document.body,
  );
}

function LoadMessages({ diagnostics }) {
  return (
    <div className="runtime-commander-diagnostics">
      {diagnostics.errors.length > 0 && (
        <div className="runtime-commander-diagnostic error">
          <strong>
            <FiAlertCircle /> Errors ({diagnostics.errors.length})
          </strong>
          <ul>
            {diagnostics.errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {diagnostics.warnings.length > 0 && (
        <div className="runtime-commander-diagnostic warning">
          <strong>
            <FiAlertTriangle /> Warnings ({diagnostics.warnings.length})
          </strong>
          <ul>
            {diagnostics.warnings.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {diagnostics.diagnostics.length > 0 && (
        <div className="runtime-commander-diagnostic info">
          <strong>Other messages ({diagnostics.diagnostics.length})</strong>
          <ul>
            {diagnostics.diagnostics.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
