import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    ReactFlowProvider,
    useReactFlow,
    useUpdateNodeInternals,
    useStoreApi,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import Header, { EditorNotice, EditorPanel, EditorPanelLedge, EditorPanelResizer } from "./components/EditorChrome.jsx";
import SkillLibrary from "./components/library/SkillLibrary";
import BehaviorLibrary from "./components/library/BehaviorLibrary";
import EditorCanvas from "./components/canvas/EditorCanvas";
import RunLogPanel from "./components/ui_log/RunLogPanel.jsx";
import EditorUtilityBar from "./components/EditorUtilityBar.jsx";
import EditorOverlays from "./components/overlays/EditorOverlays.jsx";
import WorkflowTabBar from "./components/WorkflowTabBar";
import EditorFindOverlay from "./components/canvas/EditorFindOverlay";
import EditorInspectorPanel from "./components/inspector/EditorInspectorPanel.jsx";
import { FeedbackProvider, useFeedback } from "./components/ui/index.js";

import {
    isTauri,
    initApiProxy,
} from "./tauri-client.js";
import { getParallelLaneSummaries } from "./utils/containerState.js";
import { collectDescendantGlobals, getStoredTransitionAssignments } from "./utils/editorScxml";
import { getLogicalEdgeSourceHandle, getLogicalEdgeSourceId } from "./utils/transitionSemantics";
import { getSharedContainerExitsForSkill } from "./utils/transitionDrawerLiveSync.js";
import { useEditorHistory } from "./hooks/document/useEditorHistory";
import { useNodeInteraction } from "./hooks/interaction/useNodeInteraction";
import { useSlotGraph } from "./hooks/graph/useSlotGraph";
import { useSkillDefinitions } from "./hooks/library/useSkillDefinitions";
import { useDynamicSkillConfiguration } from "./hooks/library/useDynamicSkillConfiguration";
import { useWorkflowTabs } from "./hooks/document/useWorkflowTabs";
import { useFocusHistory } from "./hooks/interaction/useFocusHistory";
import { useWorkflowDocument } from "./hooks/document/useWorkflowDocument";
import { useEditorAnalysis } from "./hooks/graph/useEditorAnalysis";
import { useEditorDisplay } from "./hooks/graph/useEditorDisplay";
import { useSkillLibraryView } from "./hooks/library/useSkillLibraryView";
import { useNodeDrag } from "./hooks/interaction/useNodeDrag";
import { useSubStateMachines } from "./hooks/document/useSubStateMachines";
import { useTransitionGraph } from "./hooks/graph/useTransitionGraph";
import { useContainerCreation } from "./hooks/graph/useContainerCreation";
import { useEditorGraphState } from "./hooks/graph/useEditorGraphState";
import { useEditorGraphMaintenance } from "./hooks/graph/useEditorGraphMaintenance";
import { useEditorPresentationGraph } from "./hooks/graph/useEditorPresentationGraph";
import { useEditorActions } from "./hooks/graph/useEditorActions";
import { useRustWorkflowDocument } from "./hooks/document/useRustWorkflowDocument";
import { useEditorClipboard } from "./hooks/interaction/useEditorClipboard";
import { useProblemNavigation } from "./hooks/interaction/useProblemNavigation";
import { useEditorSelectionController } from "./hooks/interaction/useEditorSelectionController";
import { useEditorContextMenu } from "./hooks/interaction/useEditorContextMenu";
import { useRuntimeReplay } from "./hooks/editor/useRuntimeReplay";
import { useRuntimeMemorySlots } from "./hooks/editor/useRuntimeMemorySlots.js";
import { configuredSkillSlots, skillForRuntimeState, historicalSlotValue, normalizeMemoryPath, observationForRuntimeFrame } from "./utils/runtimeMemorySlots.js";
import { traceSlot, summarizeSlot } from "./utils/slotReplayTrace.js";
import { useLiveExecution, resolveRuntimeSkill } from "./hooks/editor/useLiveExecution.js";
import { useRuntimeEventTimeline } from "./hooks/editor/useRuntimeEventTimeline.js";
import RuntimeAssignmentsDrawer, { RuntimeAssignmentsLedge } from "./components/inspector/RuntimeAssignmentsDrawer.jsx";
import { decorateLiveRuntimeNodes } from "./utils/runtimeLiveValues.js";
import { getRefreshableSkillNodeIds } from "./utils/skillDefinitionRefresh.js";
import { resolveRightPanelSwitch } from "./utils/rightPanelSwitch.js";
import { useEditorFind } from "./hooks/interaction/useEditorFind";
import { useGlobalEditorShortcuts } from "./hooks/interaction/useGlobalEditorShortcuts";
import { useEditorLibraryDrop } from "./hooks/library/useEditorLibraryDrop";
import { useEditorFlowChanges } from "./hooks/graph/useEditorFlowChanges";
import { useEditorLibraryItems } from "./hooks/library/useEditorLibraryItems";
import { useEditorDetailsCallbacks, useEditorDetailsController } from "./hooks/editor/useEditorDetailsController.js";
import { useEditorPanelLayout, useEditorPreferences } from "./hooks/editor/useEditorPreferences.js";
import { useEditorUiState, useRestoreCanvasViewportOnModeChange } from "./hooks/editor/useEditorUiState.js";
import "./App.css";
import "./styles/design-system.css";
import "./styles/interaction-states.css";
import "./styles/colorblind-mode.css";

// Initialize API proxy for Tauri desktop mode (intercepts /api/* fetch calls)
initApiProxy();


// Detect if running in Tauri desktop app
const IS_DESKTOP = isTauri();
const EMPTY_RUNTIME_CONTAINERS = [];
function AppContent() {
    const { notify } = useFeedback();
    const [isRuntimeCommanderOpen, setIsRuntimeCommanderOpen] = useState(false);
    // Changes only when the runtime Load action is invoked. Incoming log lines
    // stay inside RunLogPanel and never update App's graph state.
    const [runLogSession, setRunLogSession] = useState(0);
    const handleRunLogLoad = useCallback(() => setRunLogSession((session) => session + 1), []);
    const [runtimeAssignmentsOpen, setRuntimeAssignmentsOpen] = useState(false);
    // Run Assignments has its own width; resizing it never changes Inspector preferences.
    const [runAssignmentsWidth, setRunAssignmentsWidth] = useState(null);
    const runAssignmentsResizeRef = useRef(null);
    const [runtimeManualSkillSelection, setRuntimeManualSkillSelection] = useState(false);
    const [liveExecution, setLiveExecution] = useState(null);
    const [runtimeExpandedContainers, setRuntimeExpandedContainers] = useState({});
    // Container resizing updates frame geometry continuously but defers
    // expensive transition routing until the completed layout is committed.
    const [resizingContainerId, setResizingContainerId] = useState(null);
    const onContainerResizeStart = useCallback((id) => setResizingContainerId(id), []);

    const liveRunRef = useRef(null);
    const openRootRef = useRef(null);
    const liveOptionsRef = useRef({ followCamera: true });
    const { timeline: runtimeEventTimeline, frame: selectedRuntimeFrame,
        ingest: ingestRuntimeEvent, reset: resetRuntimeEvents,
        seek: seekRuntimeEvent, goLive: goLiveRuntimeEvent, markGap: markRuntimeGap,
        seedBaseline: seedRuntimeBaseline, confirmResume: confirmRuntimeResume } = useRuntimeEventTimeline();
    // Fast automatic transitions may enter the next state before React paints.
    // Keep the transition's canvas highlight briefly without delaying events.
    const runtimeMemory = useRuntimeMemorySlots({ enabled: isRuntimeCommanderOpen ||
        runtimeEventTimeline.frames.length > 0 || ["RUNNING", "PAUSED"].includes(runtimeEventTimeline.status) });
    const runtimeMemoryRef = useRef(runtimeMemory);
    const runtimeTabsRef = useRef([]);
    const runtimeSkillEntriesRef = useRef(new Map());
    runtimeMemoryRef.current = runtimeMemory;
    const [recentRuntimeTransition, setRecentRuntimeTransition] = useState(null);
    const runtimeTransitionTimerRef = useRef(null);
    const handleRuntimeEvent = useCallback((message) => {
        if (message.type === "started") {
            resetRuntimeEvents();
            runtimeMemoryRef.current.reset();
            runtimeSkillEntriesRef.current.clear();
        }
        // Only actual skill exits are selectable skill snapshots. SCXML also
        // emits exits for terminal/container states, which are still consumed
        // for active-state tracking but must not clutter this timeline.
        let exitedSkill = null;
        if (message.type === "state_exited") {
            const state = String(message.details?.state || message.data?.state || "");
            const root = liveRunRef.current?.workflow;
            const tabsAtLoad = liveRunRef.current?.tabsSnapshot || [];
            const knownTabs = [...new Map([...tabsAtLoad, ...runtimeTabsRef.current]
                .map((tab) => [tab.id, tab])).values()];
            exitedSkill = (root && resolveRuntimeSkill(root, knownTabs, state))
                || skillForRuntimeState(knownTabs, state);
        }
        if (message.type === "state_entered") {
            const state = String(message.details?.state || message.data?.state || "");
            const root = liveRunRef.current?.workflow;
            const tabsAtLoad = liveRunRef.current?.tabsSnapshot || [];
            const knownTabs = [...new Map([...tabsAtLoad, ...runtimeTabsRef.current]
                .map((tab) => [tab.id, tab])).values()];
            const match = (root && resolveRuntimeSkill(root, knownTabs, state))
                || skillForRuntimeState(knownTabs, state);
            // A missing editor mapping must not silently drop a skill entry.
            // Ignore known terminal states; unmatched skills can still be shown.
            const structural = knownTabs.some((tab) => (tab.nodes || []).some((node) =>
                !["custom", "submachine"].includes(node.type) &&
                [node.data?.scxmlStateId, node.data?.fullSkillName, node.data?.label]
                    .some((name) => name === state)));
            const isSkill = Boolean(match) || (state !== "End" && state !== "Fatal" && !structural);
            if (isSkill) {
                const stack = runtimeSkillEntriesRef.current.get(state) || [];
                // Bind the configured slot paths to this particular skill entry.
                // A qualified editor ID may differ from the short runtime ID,
                // and resolving the skill again on exit must not be required
                // to preserve this execution's historical slot observation.
                const mappedSlots = match ? configuredSkillSlots(match.node) : null;
                runtimeSkillEntriesRef.current.set(state, [...stack, {
                    sequence: message.sequence,
                    timestamp: message.timestamp,
                    slots: mappedSlots,
                }]);
                traceSlot("skill.enter", { state, sequence: message.sequence,
                    editorMatch: match?.node?.id || null,
                    slotPaths: mappedSlots?.map((slot) => slot.path) ?? null });
            }
            ingestRuntimeEvent({ ...message, skillSnapshot: isSkill });
        } else {
            ingestRuntimeEvent(message.type === "state_exited"
                ? { ...message, skillSnapshot: Boolean(exitedSkill) } : message);
        }
        if (message.type === "started" || message.type === "state_exited") {
            void runtimeMemoryRef.current.refresh();
        }
        if (message.type === "state_exited") {
            const state = String(message.details?.state || message.data?.state || "");
            const stack = runtimeSkillEntriesRef.current.get(state) || [];
            const entry = stack[stack.length - 1] ?? null;
            const entrySequence = typeof entry === "number" ? entry : entry?.sequence ?? null;
            runtimeSkillEntriesRef.current.set(state, stack.slice(0, -1));
            const mappedSlots = entry?.slots ?? (exitedSkill ? configuredSkillSlots(exitedSkill.node) : null);
            // Every observed skill entry needs a linked exit capture, even if
            // the editor could not resolve its slot mappings. The Memory hook
            // retains an independent path cache for such cases.
            traceSlot("skill.exit", { state, sequence: message.sequence,
                entrySequence, hasEntry: Boolean(entry), editorMatch: exitedSkill?.node?.id || null,
                mappedPaths: mappedSlots?.map((slot) => slot.path) ?? null,
                captureRequested: Boolean(entry || exitedSkill) });
            if (entry || exitedSkill) {
                runtimeMemoryRef.current.noteSkillExit({ state, entrySequence,
                    exitSequence: message.sequence, enteredAt: entry?.timestamp,
                    exitedAt: message.timestamp, slots: mappedSlots || [] });
                void runtimeMemoryRef.current.capture(state,
                    mappedSlots || [], message.sequence, "skill-exit", entrySequence);
            }
        }
        if (message.type === "transition") {
            // Transition snapshots refer to their source skill's configured
            // slots. Never attribute a write to that skill: GET only observes
            // the values available after the transition.
            const source = String(message.details?.source || message.data?.source || "");
            const root = liveRunRef.current?.workflow;
            const tabsAtLoad = liveRunRef.current?.tabsSnapshot || [];
            const knownTabs = [...new Map([...tabsAtLoad, ...runtimeTabsRef.current]
                .map((tab) => [tab.id, tab])).values()];
            const match = (root && resolveRuntimeSkill(root, knownTabs, source))
                || skillForRuntimeState(knownTabs, source);
            // All transition rows have a Memory observation. A missing editor
            // mapping must not silently drop the run-wide slot cache.
            const transitionSlots = match ? configuredSkillSlots(match.node) : [];
            traceSlot("transition.capture", { source, sequence: message.sequence,
                editorMatch: match?.node?.id || null,
                mappedPaths: transitionSlots.map((slot) => slot.path) });
            void runtimeMemoryRef.current.capture(source,
                transitionSlots, message.sequence, "transition");
            const data = message.data || message.details || {};
            clearTimeout(runtimeTransitionTimerRef.current);
            setRecentRuntimeTransition({
                source: String(data.source || ""), target: String(data.target || ""),
                event: String(data.event || ""),
            });
            runtimeTransitionTimerRef.current = setTimeout(() => setRecentRuntimeTransition(null), 650);
        }
    }, [ingestRuntimeEvent, resetRuntimeEvents]);
    useEffect(() => () => clearTimeout(runtimeTransitionTimerRef.current), []);

    const flowStore = useStoreApi();
    const cancelFlowConnection = useCallback(() => flowStore.getState().cancelConnection(), [flowStore]);
    const {
        skills,
        isReloadingSkills,
        skillLibraryRefreshVersion,
        skillLibraryStatus,
        skillLibraryError,
        hasLoadedSkills,
        fetchSkills,
        fetchSkillData,
    } = useSkillDefinitions();
    const updateNodeInternals = useUpdateNodeInternals();
    const {
        behaviorDirectories,
        setBehaviorDirectories,
        showTransitionEdges,
        setShowTransitionEdges,
        showSlotEdges,
        setShowSlotEdges,
        showCodeViewButton,
        setShowCodeViewButton,
        colorblindMode,
        setColorblindMode,
    } = useEditorPreferences();
    const basePanels = useEditorPanelLayout();
    // Runtime Load can finish after panel-mode changes. Keep the latest panel
    // controller without recreating the long-lived runtime callback.
    const collapseLibraryRef = useRef(() => {});
    collapseLibraryRef.current = () => basePanels.closePanel("library");
    // Both right-side panels act as tabs: opening either closes the other.
    // Library visibility and inspector width preferences remain independent.
    const switchRightPanel = useCallback((action) => {
        const next = resolveRightPanelSwitch({
            inspectorOpen: basePanels.inspectorOpen,
            assignmentsOpen: runtimeAssignmentsOpen,
        }, action);
        if (next.inspectorOpen !== basePanels.inspectorOpen) {
            if (next.inspectorOpen) basePanels.showPanel("inspector");
            else basePanels.closePanel("inspector");
        }
        if (next.assignmentsOpen !== runtimeAssignmentsOpen) {
            setRuntimeAssignmentsOpen(next.assignmentsOpen);
        }
    }, [basePanels.inspectorOpen, basePanels.showPanel, basePanels.closePanel, runtimeAssignmentsOpen]);
    const showPanel = useCallback((side) => {
        if (side === "inspector") switchRightPanel("open-inspector");
        else basePanels.showPanel(side);
    }, [switchRightPanel, basePanels.showPanel]);
    const togglePanel = useCallback((side) => {
        if (side === "inspector") switchRightPanel("toggle-inspector");
        else basePanels.togglePanel(side);
    }, [switchRightPanel, basePanels.togglePanel]);
    const panels = { ...basePanels, showPanel, togglePanel };
    const toggleRuntimeAssignments = useCallback(() => switchRightPanel("toggle-assignments"), [switchRightPanel]);
    const showRuntimeAssignments = useCallback(() => switchRightPanel("open-assignments"), [switchRightPanel]);
    const assignmentsVisible = runtimeAssignmentsOpen && (isRuntimeCommanderOpen || runtimeEventTimeline.frames.length > 0);
    const maxAssignmentsWidth = Math.max(0, panels.inspectorMaxWidth - (panels.isDocked ? 6 : 0));
    const minAssignmentsWidth = Math.min(190, maxAssignmentsWidth);
    const constrainAssignmentsWidth = (value) => Math.max(minAssignmentsWidth, Math.min(maxAssignmentsWidth, value));
    const effectiveAssignmentsWidth = constrainAssignmentsWidth(runAssignmentsWidth ?? panels.preferences.inspectorWidth);
    const startAssignmentsResize = (event) => {
        if (!panels.isDocked || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        runAssignmentsResizeRef.current = { pointerId: event.pointerId, x: event.clientX,
            width: effectiveAssignmentsWidth };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };
    const moveAssignmentsResize = (event) => {
        const gesture = runAssignmentsResizeRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        setRunAssignmentsWidth(constrainAssignmentsWidth(gesture.width - (event.clientX - gesture.x)));
    };
    const finishAssignmentsResize = (event) => {
        const gesture = runAssignmentsResizeRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        runAssignmentsResizeRef.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
    };
    const keyAssignmentsResize = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        setRunAssignmentsWidth(event.key === "Home" ? minAssignmentsWidth :
            event.key === "End" ? maxAssignmentsWidth :
                constrainAssignmentsWidth(effectiveAssignmentsWidth + (event.key === "ArrowLeft" ? 16 : -16)));
    };

    //---- TAB / GRAPH MANAGEMENT ----
    const {
        nodes,
        setNodes,
        updateGraph,
        onNodesChange,
        flushPendingNodeChanges,
        edges,
        setEdges,
        onEdgesChange,
        slotNodes,
        setSlotNodes,
        onSlotNodesChange,
        slotEdges,
        setSlotEdges,
        onSlotEdgesChange,
        manualSlots,
        setManualSlots,
        globalDataModel,
        setGlobalDataModel,
        inheritedGlobalDataModel,
        replaceDocument,
        getDocumentSnapshot,
    } = useEditorGraphState();
    // Flush the last resize frame before NodeResizer clamps/fits final geometry.
    const onContainerResizeEnd = useCallback(() => {
        flushPendingNodeChanges();
        setResizingContainerId(null);
    }, [flushPendingNodeChanges]);

    const availableDataModelParameters = useMemo(() => {
        const parameters = [];
        const seen = new Set();

        // Parent globals take precedence when a child defines the same global.
        [...(inheritedGlobalDataModel || []), ...(globalDataModel || [])].forEach(
            (parameter) => {
                if (!parameter?.id || seen.has(parameter.id)) return;
                seen.add(parameter.id);
                parameters.push(parameter);
            }
        );
        return parameters;
    }, [inheritedGlobalDataModel, globalDataModel]);

    const {
        selectedPackage,
        setSelectedPackage,
        selectedSubPackage,
        setSelectedSubPackage,
        activeFilter,
        setActiveFilter,
        searchText,
        setSearchText,
        contextMenu,
        setContextMenu,
        controlPointInsertRequest,
        setControlPointInsertRequest,
        leftLibraryTab,
        setLeftLibraryTab,
        isHintPageOpen,
        setIsHintPageOpen,
        activeMode,
        setActiveMode,
        isCreateSlotModalOpen,
        setIsCreateSlotModalOpen,
        pendingSubMachineCreation,
        setPendingSubMachineCreation,
        stateMachineLoading,
        beginStateMachineLoad,
        endStateMachineLoad,
        activeTab,
        setActiveTab,
        rightPanelTab,
        setRightPanelTab,
    } = useEditorUiState({ showPanel });

    const {
        selectedNodeId,
        setSelectedNodeId,
        hoveredSlotAccessNodeId,
        setHoveredSlotAccessNodeId,
        hoveredEditorNodeId,
        setHoveredEditorNodeId,
        hoveredEditorEdgeId,
        setHoveredEditorEdgeId,
        hoverTransitionEdge,
        hoverTransitionNode,
        parameterFocusRequest,
        slotFocusRequest,
        transitionFocusRequest,
        handleOpenStateActions,
        handleOpenParameter,
        handleOpenSlot,
        handleOpenTransition,
    } = useNodeInteraction({
        setNodes,
        setRightPanelTab,
        setActiveTab,
    });

    const { checkSlotConnection } = useSlotGraph({
        nodes,
        manualSlots,
        slotNodes,
        slotEdges,
        setSlotNodes,
        setSlotEdges,
        getDocumentSnapshot,
    });

    const rustWorkflowDocument = useRustWorkflowDocument({
        nodes,
        edges,
        globalDataModel,
        manualSlots,
        setNodes,
        setEdges,
        updateGraph,
        setGlobalDataModel,
    });
    const invalidateRustDocument = rustWorkflowDocument.invalidate;
    useLayoutEffect(() => () => invalidateRustDocument(), [invalidateRustDocument]);

    const {
        selectEditorNode,
        clearEditorNodeSelection,
        createEditorReference,
        setNodeAsInitial,
        addEmptyStateToContainer,
        updateSlotPath,
        updateSlotInherited,
        createManualSlot,
        clearTransitionSelection,
        clearAllEdgeSelection,
        selectTransitionEdge,
        selectSlotEdge,
        updateNodeEvent,
        setExistingTargetForEvent,
        moveContainerTransition,
        updateNodeName,
        updateNodeSource,
        getNodeParameterEditSource,
        updateNodeParameter,
        toggleContainerCollapse,
        updateEdgeControlPoints,
        updateStateActions,
        updateSendEvents,
        updateSkillSlotPath,
        updateGlobalParameter,
        addGlobalParameter,
        deleteGlobalParameter,
    } = useEditorActions({
        nodes,
        getDocumentSnapshot,
        getActiveDocumentIdentity: () => getActiveDocumentIdentity(),
        edges,
        slotNodes,
        slotEdges,
        manualSlots,
        globalDataModel,
        valueVariables: availableDataModelParameters,
        selectedNodeId,
        setNodes,
        setEdges,
        setSlotNodes,
        setSlotEdges,
        setManualSlots,
        setGlobalDataModel,
        setSelectedNodeId,
        setRightPanelTab,
        setActiveTab,
        checkSlotConnection,
        updateNodeInternals,
        applyWorkflowCommand: rustWorkflowDocument.applyWorkflowCommand,
        syncInsertedParallelLaneStateAfterCommit:
            rustWorkflowDocument.syncInsertedParallelLaneStateAfterCommit,
        syncStateEditorPositions:
            rustWorkflowDocument.syncStateEditorPositions,
        syncTransitionsForSource:
            rustWorkflowDocument.syncTransitionsForSource,
        syncStateParameters: rustWorkflowDocument.syncStateParameters,
        syncSlotsAfterCommit: rustWorkflowDocument.syncSlotsAfterCommit,
        // Actions run after the tab-aware configuration hook below is initialized.
        updateEventsFromParameters: (nodeId, params) => updateEventsFromParameters(nodeId, params),
        setControlPointInsertRequest,
    });

    const {
        screenToFlowPosition,
        fitView,
        getNodes,
        setCenter,
        getViewport,
        setViewport,
    } = useReactFlow();

    const {
        hasGraphClipboard,
        flowContainerRef,
        editorPointerPositionRef,
        handleGraphSelectionChange,
        captureGraphSelection,
        requestGraphPaste,
    } = useEditorClipboard({
        activeMode,
        selectedNodeId,
        nodes,
        edges,
        slotNodes,
        setNodes,
        setEdges,
        setSlotNodes,
        setSlotEdges,
        setSelectedNodeId,
        setRightPanelTab,
        setActiveTab,
        clearAllEdgeSelection,
        checkSlotConnection,
        updateNodeInternals,
        screenToFlowPosition,
        syncPastedEditorSubgraphAfterCommit:
            rustWorkflowDocument.syncPastedEditorSubgraphAfterCommit,
        syncStateEditorPositions:
            rustWorkflowDocument.syncStateEditorPositions,
        onParallelSkillConflict: (message) => notify({ tone: "danger", message, id: "parallel-lane-duplicate", duration: 2300 }),
    });
    useRestoreCanvasViewportOnModeChange({ activeMode, fitView, getNodes });

    const {
        parallelDropTargetId,
        setParallelDropTargetId,
        compoundDropTargetId,
        setCompoundDropTargetId,
        isDraggingNode,
        draggingNodeId,
        isOverTrash,
        handleNodeDragStart,
        handleNodeDrag,
        handleNodeDragStop,
    } = useNodeDrag({
        updateGraph,
        activeMode,
        setNodes,
        setSelectedNodeId,
        setHoveredEditorEdgeId,
        screenToFlowPosition,
        getNodes,
        flushPendingNodeChanges,
        syncStatePosition: rustWorkflowDocument.syncStatePosition,
        syncStateEditorPositions:
            rustWorkflowDocument.syncStateEditorPositions,
        syncRemovedStates: rustWorkflowDocument.syncRemovedStates,
        onParallelSkillConflict: (message) => notify({ tone: "danger", message, id: "parallel-lane-duplicate", duration: 2300 }),
    });

    const semanticNodes = useEditorGraphMaintenance({
        nodes,
        isDraggingNode,
        selectedNodeId,
        setNodes,
        updateGraph,
        setSelectedNodeId,
    });

    const {
        drawerData,
        liveDrawerData,
        setDrawerData,
        slotConnectionDrag,
        pendingSlotRename,
        cancelSlotRename,
        confirmSlotRename,
        openConditionDrawer,
        isValidConnection,
        handleConnectStart,
        handleConnectEnd,
        handleReconnectStart,
        handleReconnectEnd,
        onReconnect,
        onConnect,
        onEdgeDoubleClick,
        handleConfirmDrawer,
    } = useTransitionGraph({
        nodes,
        edges,
        slotNodes,
        slotEdges,
        manualSlots,
        selectedNodeId,
        setNodes,
        setEdges,
        updateGraph,
        setSlotNodes,
        setSlotEdges,
        setManualSlots,
        setGlobalDataModel,
        setSelectedNodeId,
        updateNodeInternals,
        selectTransitionEdge,
        syncTransitionsForSource:
            rustWorkflowDocument.syncTransitionsForSource,
        checkSlotConnection,
        syncSlotsAfterCommit: rustWorkflowDocument.syncSlotsAfterCommit,
        getDocumentSnapshot,
        // The tab hook below publishes identity before replacing the graph.
        getActiveDocumentIdentity: () => getActiveDocumentIdentity(),
        screenToFlowPosition,
        flowContainerRef,
        cancelFlowConnection,
        onSlotConnectionError: (message) => notify({ tone: "danger", title: "Slot connection", message }),
        setNodeAsInitial,
    });

    const {
        handleEdgeClick,
        handleEdgeDoubleClick: handleEditorEdgeDoubleClick,
        handleNodeClick,
        handleNodeDoubleClick,
        handlePaneClick,
        handleNodeMouseEnter,
        handleNodeMouseLeave,
        handleEdgeMouseEnter,
        handleEdgeMouseLeave,
    } = useEditorSelectionController({
        nodes,
        edges,
        clearAllEdgeSelection,
        selectSlotEdge,
        selectTransitionEdge,
        onTransitionEdgeDoubleClick: onEdgeDoubleClick,
        setSelectedNodeId,
        setRightPanelTab,
        setActiveTab,
        setHoveredEditorNodeId,
        setHoveredEditorEdgeId,
    });

    const {
        selectedNodes,
        handleCreateEmptyCompound,
        handleAddLaneToParallel,
        handleRenameParallelLane,
        handleMoveParallelLane,
        handleDeleteParallelLane,
        handleCreateEmptyParallel,
        handleCreateCompoundFromSelected,
        handleCreateParallelFromSelected,
    } = useContainerCreation({
        updateGraph,
        nodes,
        edges,
        isDraggingNode,
        setNodes,
        setSelectedNodeId,
        setActiveTab,
        setContextMenu,
        updateNodeInternals,
        syncInsertedEditorStatesAfterCommit:
            rustWorkflowDocument.syncInsertedEditorStatesAfterCommit,
        syncWrappedContainerAfterCommit:
            rustWorkflowDocument.syncWrappedContainerAfterCommit,
        syncEditorStateAfterCommit:
            rustWorkflowDocument.syncEditorStateAfterCommit,
    });

    const {
        tabs,
        activeTabId,
        activeTab: activeWorkflowTab,
        activeFingerprint: activeWorkflowFingerprint,
        getActiveDocumentIdentity,
        getTabSnapshot,
        getTabsSnapshot,
        updateTab,
        replaceTabDocument,
        tabPathTooltip,
        draggedTabId,
        switchTab,
        openTab,
        handleAddNewTab,
        closeTab,
        handleTabDragStart,
        handleTabDragOver,
        handleTabDragEnd,
        handleTabMouseEnter,
        handleTabMouseLeave,
    } = useWorkflowTabs({
        nodes,
        edges,
        slotNodes,
        slotEdges,
        manualSlots,
        globalDataModel,
        inheritedGlobalDataModel,
        replaceDocument,
        getDocumentSnapshot,
        selectedNodeId,
        setSelectedNodeId,
        fitView,
        getViewport,
        setViewport,
        syncRustDocument: rustWorkflowDocument.syncEditorState,
        cancelFlowConnection,
        isDraggingNode,
    });
    runtimeTabsRef.current = tabs;

    // A replaced/reloaded workflow may reuse edge ids; never retain a hover
    // originating from the previous canvas or its now-unmounted details panel.
    useEffect(() => {
        hoverTransitionEdge(null);
        hoverTransitionNode(null);
    }, [activeTabId, activeWorkflowTab?.documentGeneration, hoverTransitionEdge, hoverTransitionNode]);

    const { updateEventsFromParameters } = useDynamicSkillConfiguration({
        getDocumentSnapshot,
        getActiveDocumentIdentity,
        setNodes,
        fetchSkillData,
        checkSlotConnection,
        syncStateConfigurationAfterCommit:
            rustWorkflowDocument.syncStateConfigurationAfterCommit,
    });

    // Refresh *definitions*, not the ReactFlow root. Remounting the canvas
    // discards viewport/handle state and has previously caused white flashes.
    const refreshEditorNodes = useCallback(async () => {
        const owner = getActiveDocumentIdentity();
        await fetchSkills({ manual: true }); // invalidates even unchanged skill-name lists
        if (getActiveDocumentIdentity() !== owner) return { message: 'Document changed; refresh cancelled' };
        const ids = getRefreshableSkillNodeIds(getDocumentSnapshot().nodes);
        // Native SCXML state configuration commits are serialized. Refreshing
        // many skills concurrently could otherwise race Rust patches.
        let failed = 0;
        for (const id of ids) {
            if (getActiveDocumentIdentity() !== owner) break;
            try {
                if (await updateEventsFromParameters(id) !== true) failed += 1;
            } catch {
                failed += 1;
            }
        }
        if (getActiveDocumentIdentity() !== owner) return { message: 'Document changed; refresh cancelled' };
        // Force ReactFlow to measure newly added/removed ports after data arrives.
        requestAnimationFrame(() => {
            if (getActiveDocumentIdentity() === owner) updateNodeInternals(ids);
        });
        return { message: failed ? `${ids.length - failed} updated, ${failed} failed` :
            `Refreshed ${ids.length} skill node${ids.length === 1 ? '' : 's'}` };
    }, [fetchSkills, getActiveDocumentIdentity, getDocumentSnapshot, updateEventsFromParameters, updateNodeInternals]);

    const {
        canGoBack: canGoFocusBack,
        canGoForward: canGoFocusForward,
        goBack: goFocusBack,
        goForward: goFocusForward,
    } = useFocusHistory({
        activeTabId,
        selectedNodeId,
        tabs,
        switchTab,
        setNodes,
        setSlotNodes,
        setSelectedNodeId,
        setRightPanelTab,
        fitView,
    });

    const {
        handleCreateEmptySubMachine,
        hydrateSubMachineInheritedSlots,
        handleOpenSubMachine,
        handleCreateSubMachineFromSelected,
    } = useSubStateMachines({
        selectedNodes,
        activeTabId,
        getTabSnapshot,
        getTabsSnapshot,
        switchTab,
        openTab,
        behaviorDirectories,
        fetchSkillData,
        setContextMenu,
        checkSlotConnection,
        onStateMachineLoadStart: () => {
            collapseLibraryRef.current();
            beginStateMachineLoad();
        },
        onStateMachineLoadEnd: endStateMachineLoad,
    });

    const {
        handleOpenBehaviorFile,
        createBehaviorNode,
        createNode,
    } = useEditorLibraryItems({
        nodes,
        getDocumentSnapshot,
        behaviorDirectories,
        fetchSkillData,
        hydrateSubMachineInheritedSlots,
        handleOpenSubMachine,
        switchTab,
        openTab,
        getTabsSnapshot,
        checkSlotConnection,
        beginStateMachineLoad,
        endStateMachineLoad,
    });

    const descendantGlobalDataModel = useMemo(() => {
        const blockedIds = [
            ...(inheritedGlobalDataModel || []),
            ...(globalDataModel || []),
        ]
            .filter((parameter) =>
                String(parameter.id || "").startsWith("_")
            )
            .map((parameter) => parameter.id);

        return collectDescendantGlobals(
            tabs,
            activeTabId,
            blockedIds
        );
    }, [
        tabs,
        activeTabId,
        globalDataModel,
        inheritedGlobalDataModel,
    ]);

    useEditorHistory({
        activeTabId,
        activeMode,
        isDraggingNode,
        nodes,
        edges,
        slotNodes,
        slotEdges,
        manualSlots,
        globalDataModel,
        setNodes,
        setEdges,
        setSlotNodes,
        setSlotEdges,
        setManualSlots,
        setGlobalDataModel,
        setSelectedNodeId,
        setRightPanelTab,
        updateNodeInternals,
        syncRustDocument: rustWorkflowDocument.syncEditorState,
    });


    const {
        semanticSlotNodes,
        displaySemanticNodes,
        displayNodes,
        nodeById,
        childIdsByParent,
        semanticChildrenByParent,
        hiddenNodeIds,
        slotNodeIdSet,
        injectedNodes,
        injectedSlotNodes,
    } = useEditorPresentationGraph({
        semanticNodes,
        runtimeExpandedContainerIds: runtimeExpandedContainers[activeTabId] || EMPTY_RUNTIME_CONTAINERS,
        slotNodes,
        isDraggingNode,
        nodes,
        edges,
        tabs,
        activeTabId,
        activeMode,
        slotConnectionDrag,
        handleAddLaneToParallel,
        handleOpenStateActions,
        handleOpenParameter,
        getNodeParameterEditSource,
        updateNodeParameter,
        parameterValueVariables: availableDataModelParameters,
        handleOpenSlot,
        // Canvas event-row double clicks open the transition editor directly;
        // the separate inspector-focus callback remains available elsewhere.
        handleOpenTransition: openConditionDrawer,
        handleOpenSubMachine,
        handleToggleContainerCollapse: toggleContainerCollapse,
        onContainerResizeStart,
        onContainerResizeEnd,
        resizingContainerId,
    });

    const selectedRawNode = useMemo(() => {
        const semanticNode =
            [...semanticNodes, ...semanticSlotNodes].find(
                (node) => node.id === selectedNodeId
            ) || null;

        if (!semanticNode || semanticNode.type === "slot") {
            return semanticNode;
        }

        // Reconcile pending slot edits from the live node while retaining the
        // semantic projection's drag-stable geometry and identity.
        const liveNode = nodes.find((node) => node.id === selectedNodeId);
        if (liveNode?.data && liveNode.data !== semanticNode.data) {
            return {
                ...semanticNode,
                data: liveNode.data,
            };
        }

        return semanticNode;
    }, [
        semanticNodes,
        semanticSlotNodes,
        nodes,
        selectedNodeId,
    ]);

    const selectedParallelLanes = useMemo(
        () => getParallelLaneSummaries(selectedRawNode, semanticChildrenByParent),
        [selectedRawNode, semanticChildrenByParent],
    );

    const {
        selectedSlotDetails,
        canvasSlotPathOptions,
        canvasSkillSlotOptions,
        selectedContainerOutgoingTransitions,
        editorProblems,
        nodeWarningTitles,
        validationStatus,
        errorProblemCount,
    } = useEditorAnalysis({
        tabs,
        activeTabId,
        getActiveDocumentIdentity,
        semanticNodes,
        semanticSlotNodes,
        manualSlots,
        isDraggingNode,
        selectedRawNode,
        edges,
        globalDataModel,
        availableDataModel: availableDataModelParameters,
        behaviorDirectories,
        runRustReadQuery: rustWorkflowDocument.runReadQuery,
        validationRevision: rustWorkflowDocument.validationRevision,
    });

    // Keep the open transition inspector in sync with the selected skill.
    // Edge-driven opening can change the drawer without changing the selection.
    const previousTransitionSelectionRef = useRef(selectedNodeId);
    useEffect(() => {
        const previous = previousTransitionSelectionRef.current;
        previousTransitionSelectionRef.current = selectedNodeId;
        if (!drawerData.isOpen || !selectedNodeId || previous === selectedNodeId ||
            drawerData.sourceNodeId === selectedNodeId) return;
        const node = nodes.find(item => item.id === selectedNodeId);
        if (!node || !["custom", "submachine"].includes(node.type) ||
            node.data?.isSkillClone || node.data?.isStateClone) return;
        openConditionDrawer(selectedNodeId);
    }, [selectedNodeId, drawerData.isOpen, drawerData.sourceNodeId, nodes, openConditionDrawer]);

    const {
        selectedNode,
        selectedCloneSourceNode,
        selectedNodeClones,
        selectedActionDataModel,
        selectedActionExpressionVariables,
        hasInitialNode,
        handleMoveContainerTransition,
        handleNavigateCloneSource,
        handleUpdateSelectedSlotPath,
        handleUpdateSelectedSlotInherited,
        handleSelectSlotAccessSkill,
        handleNavigateDescendantSlotSkill,
        handleNavigateAncestorSlot,
    } = useEditorDetailsController({
        selectedRawNode,
        semanticNodes,
        tabs,
        activeTabId,
        availableDataModelParameters,
        selectedContainerOutgoingTransitions,
        moveContainerTransition,
        getNodes,
        setNodes,
        updateNodeInternals,
        handleToggleContainerCollapse: toggleContainerCollapse,
        clearAllEdgeSelection,
        selectEditorNode,
        fitView,
        setCenter,
        setHoveredSlotAccessNodeId,
        switchTab,
        handleOpenSubMachine,
        setRightPanelTab,
        updateSlotPath,
        updateSlotInherited,
    });

    const handleProblemClick = useProblemNavigation({
        edges,
        setEdges,
        setNodes,
        setSelectedNodeId,
        setActiveMode,
        setShowTransitionEdges,
        setActiveTab,
        setRightPanelTab,
        getNodes,
        setCenter,
        fitView,
        updateNodeInternals,
        selectEditorNode,
    });

    const {
        packages,
        directSkills,
        packageSkills,
        subPackages,
        searchedSkills,
        filteredSkills,
    } = useSkillLibraryView({
        skills: skills.skills,
        selectedPackage,
        selectedSubPackage,
        searchText,
        activeFilter,
    });

    const handleControlPointContextMenu = useCallback(
        (event, edgeId, pointId, edgeKind = "transition") => {
            event.preventDefault();
            event.stopPropagation();

            setContextMenu({
                kind: "control-point",
                x: event.clientX,
                y: event.clientY,
                edgeId,
                pointId,
                edgeKind,
                title: "Control point",
            });
        },
        [setContextMenu]
    );

    const variableProblemNodeIds = useMemo(
        () =>
            new Set(
                editorProblems
                    .filter((problem) => problem.category === "Variables")
                    .flatMap((problem) =>
                        problem.focusNodeIds?.length
                            ? problem.focusNodeIds
                            : problem.nodeId
                                ? [problem.nodeId]
                                : []
                    )
                    .filter(Boolean)
            ),
        [editorProblems]
    );

    const hoverTransitionBadge = useCallback((edgeId, event) => {
        if (edgeId) hoverTransitionNode(null);
        hoverTransitionEdge(edgeId, event);
    }, [hoverTransitionEdge, hoverTransitionNode]);

    const handleTransitionBadgeClick = useCallback((edge, section) => {
        hoverTransitionEdge(null);
        selectTransitionEdge(edge.id);
        openConditionDrawer(
            getLogicalEdgeSourceId(edge),
            getLogicalEdgeSourceHandle(edge),
            edge.target,
            null,
            { edgeId: edge.id, focusSection: section }
        );
    }, [selectTransitionEdge, openConditionDrawer, hoverTransitionEdge]);

    const {
        visibleNodes,
        visibleEdges,
        smartRoutingNodes,
        edgeFocusMode,
        nodeFocusMode,
    } = useEditorDisplay({
        nodeWarningTitles,
        hoveredEditorNodeId,
        hoveredEditorEdgeId,
        selectedNodes,
        selectedNodeId,
        edges,
        nodeById,
        slotNodeIdSet,
        slotEdges,
        updatePersistentEdgeControlPoints: updateEdgeControlPoints,
        controlPointInsertRequest,
        onControlPointContextMenu: handleControlPointContextMenu,
        onOpenTransitionBadge: handleTransitionBadgeClick,
        onHoverTransitionBadge: hoverTransitionBadge,
        hoveredSlotAccessNodeId,
        semanticNodes: displaySemanticNodes,
        semanticChildrenByParent,
        nodes: displayNodes,
        childIdsByParent,
        activeMode,
        showTransitionEdges,
        showSlotEdges,
        colorblindMode,
        injectedNodes,
        injectedSlotNodes,
        isDraggingNode: isDraggingNode || Boolean(resizingContainerId),
        draggingNodeId,
        hiddenNodeIds,
        parallelDropTargetId,
        compoundDropTargetId,
        problemNodeIds: variableProblemNodeIds,
    });


    const {
        runtimeLog,
        runtimePreparation,
        runtimePlayback,
        activeRuntimeChanges,
        runtimeChangesPanelOpen,
        setRuntimeChangesPanelOpen,
        playbackVisibleNodes,
        playbackVisibleEdges,
        handleLoadRuntimeLog,
        handleClearRuntimeLog,
        toggleRuntimePlayback,
        restartRuntimePlayback,
        seekRuntimePlayback,
        stepRuntimePlayback,
        setRuntimePlaybackDelay,
    } = useRuntimeReplay({
        tabs,
        activeTabId,
        nodes,
        edges,
        slotNodes,
        slotEdges,
        globalDataModel,
        visibleNodes,
        visibleEdges,
        fitView,
        switchTab,
        setActiveMode,
    });

    const handleExecutionUpdate = useCallback((update) => {
        if (update.action === "load") setRuntimeExpandedContainers({});
        if (update.action === "load" && update.workflow) {
            collapseLibraryRef.current();
            liveRunRef.current = { workflow: update.workflow, tabsSnapshot: update.tabsSnapshot || [update.workflow] };
        }
        if (update.followCamera !== undefined) {
            liveOptionsRef.current = {
                ...liveOptionsRef.current, followCamera: update.followCamera,
                autoOpenSubMachines: update.autoOpenSubMachines,
                autoExpandCompounds: update.autoExpandCompounds,
                autoExpandParallels: update.autoExpandParallels,
            };
            setLiveExecution((previous) => previous
                ? { ...previous, ...liveOptionsRef.current } : previous);
        }
        if (update.action === "start" || update.action === "resume") {
            if (update.action === "resume") confirmRuntimeResume();
            handleClearRuntimeLog();
            setActiveMode("overview");
        }
        if (!update.workflow || update.action === "stop" || update.action === "load") {
            if (update.action === "stop" || !update.workflow) {
                setRuntimeExpandedContainers((current) => Object.keys(current).length ? {} : current);
                setLiveExecution(null);
            }
            return;
        }
        if (liveRunRef.current?.workflow !== update.workflow) {
            liveRunRef.current = { workflow: update.workflow, tabsSnapshot: [update.workflow] };
        }
        // The selected event snapshot (including manual timeline scrubbing) owns the
        // live canvas projection; control calls no longer overwrite it with polling.
    }, [handleClearRuntimeLog, setActiveMode, confirmRuntimeResume]);

    const handleRuntimeGap = useCallback(() => { markRuntimeGap(); }, [markRuntimeGap]);
    const handleRuntimeReset = useCallback(() => {
        resetRuntimeEvents();
        runtimeMemoryRef.current.reset();
        runtimeSkillEntriesRef.current.clear();
        setLiveExecution(null);
        setRecentRuntimeTransition(null);
    }, [resetRuntimeEvents]);

    // Only changing top-level documents resets runtime data. Switching into a
    // sub-SM tab leaves its parent execution and historical inspection intact.
    const openRoot = (() => {
        const byId = new Map((tabs || []).map((tab) => [tab.id, tab]));
        let current = byId.get(activeTabId);
        const visited = new Set();
        while (current?.parentTabId && byId.has(current.parentTabId) && !visited.has(current.id)) {
            visited.add(current.id);
            current = byId.get(current.parentTabId);
        }
        return current?.id || null;
    })();
    useEffect(() => {
        if (!openRoot) return;
        if (openRootRef.current !== null && openRootRef.current !== openRoot) {
            handleRuntimeReset();
            liveRunRef.current = null;
        }
        openRootRef.current = openRoot;
    }, [openRoot, handleRuntimeReset]);

    useEffect(() => {
        const loaded = liveRunRef.current;
        if (!loaded || !selectedRuntimeFrame) {
            setLiveExecution(null);
            return;
        }
        const transition = runtimeEventTimeline.watching
            ? recentRuntimeTransition || selectedRuntimeFrame.transition : selectedRuntimeFrame.transition;
        // The selected snapshot owns the *entire* active configuration, even
        // when a transition is focused and other Parallel lanes keep running.
        const currentStates = selectedRuntimeFrame.activeStates || [];
        const transitions = selectedRuntimeFrame.transitions?.length
            ? selectedRuntimeFrame.transitions : selectedRuntimeFrame.transition
                ? [selectedRuntimeFrame.transition] : [];
        setLiveExecution({ ...loaded, following: true, followCamera: true,
            ...liveOptionsRef.current, snapshot: {
                status: runtimeEventTimeline.watching ? runtimeEventTimeline.status : "RUNNING",
                currentStates, transition, transitions,
                enteredStates: selectedRuntimeFrame.enteredStates || [],
                exitedStates: selectedRuntimeFrame.exitedStates || [],
                exitingStates: selectedRuntimeFrame.exitingStates || [],
                completedStates: selectedRuntimeFrame.completedStates || [],
                finishedStates: selectedRuntimeFrame.finishedStates || [],
                stateEntryHistory: selectedRuntimeFrame.stateEntryHistory || [],
                checkedAt: Date.now(), stateIds: [],
            }, action: "event_snapshot", focusRequest: selectedRuntimeFrame.id });
    }, [selectedRuntimeFrame, runtimeEventTimeline.index, runtimeEventTimeline.watching,
        runtimeEventTimeline.status, recentRuntimeTransition]);

    const {
        handleNodesChange,
        handleVisibleEdgesChange,
    } = useEditorFlowChanges({
        updateGraph,
        nodeById,
        slotNodeIdSet,
        onNodesChange,
        onSlotNodesChange,
        onEdgesChange,
        onSlotEdgesChange,
        nodes,
        edges,
        slotNodes,
        slotEdges,
        setNodes,
        setSlotEdges,
        manualSlots,
        setManualSlots,
        getDocumentSnapshot,
        checkSlotConnection,
        syncSlotsAfterCommit: rustWorkflowDocument.syncSlotsAfterCommit,
        updateNodeInternals,
        syncRemovedStates: rustWorkflowDocument.syncRemovedStates,
        syncTransitionSources: rustWorkflowDocument.syncTransitionSources,
    });

    const {
        handleContextMenuOpen,
        handleSelectAction,
    } = useEditorContextMenu({
        updateGraph,
        syncEditorStateAfterCommit: rustWorkflowDocument.syncEditorStateAfterCommit,
        contextMenu,
        setContextMenu,
        manualSlots,
        getDocumentSnapshot,
        nodes,
        edges,
        slotNodes,
        slotEdges,
        selectedNodes,
        activeMode,
        behaviorDirectories,
        screenToFlowPosition,
        selectSlotEdge,
        selectTransitionEdge,
        selectEditorNode,
        setNodes,
        setSlotNodes,
        setSelectedNodeId,
        setRightPanelTab,
        setActiveTab,
        setNodeAsInitial,
        createEditorReference,
        captureGraphSelection,
        requestGraphPaste,
        handleOpenTransition,
        handleCreateCompoundFromSelected,
        handleCreateEmptyCompound,
        handleCreateParallelFromSelected,
        handleCreateEmptyParallel,
        setPendingSubMachineCreation,
        setIsCreateSlotModalOpen,
        addEmptyStateToContainer,
        handleAddLaneToParallel,
        handleNodesChange,
        onEdgeDoubleClick,
        openConditionDrawer,
        handleNavigateCloneSource,
        setControlPointInsertRequest,
        updatePersistentEdgeControlPoints: updateEdgeControlPoints,
        handleVisibleEdgesChange,
        handleOpenSlot,
        clearAllEdgeSelection,
        getNodes,
        setCenter,
    });

    const {
        isFindOpen,
        setIsFindOpen,
        findQuery,
        setFindQuery,
        findResultIndex,
        setFindResultIndex,
        findInputRef,
        findPanelRef,
        findResults,
        focusFindResult,
    } = useEditorFind({
        activeMode,
        setActiveMode,
        semanticNodes,
        slotNodes,
        manualSlots,
        nodes,
        clearAllEdgeSelection,
        checkSlotConnection,
        selectEditorNode,
        fitView,
    });

    const {
        handleOpenDocument,
        handleSaveCurrentTab,
        handleSaveAsCurrentTab,
        handleCloseTab,
        handleTabMiddleMouseDown,
        documentGuard,
        hasFilePath: activeWorkflowHasFilePath,
        isSaving: isWorkflowSaving,
        isOpening: isWorkflowOpening,
        documentNotice,
        dismissDocumentNotice,
        handleRetryDocumentAction,
    } = useWorkflowDocument({
        isDesktop: IS_DESKTOP,
        activeTab: activeWorkflowTab,
        getTabSnapshot,
        getTabsSnapshot,
        updateTab,
        replaceTabDocument,
        closeTab,
        fetchSkillData,
        hydrateSubMachineInheritedSlots,
        checkSlotConnection,
        onStateMachineLoadStart: () => {
            collapseLibraryRef.current();
            beginStateMachineLoad();
        },
        onStateMachineLoadEnd: endStateMachineLoad,
    });

    const expandRuntimeContainer = useCallback((tabId, containerId) => {
        setRuntimeExpandedContainers((previous) => {
            const ids = previous[tabId] || EMPTY_RUNTIME_CONTAINERS;
            return ids.includes(containerId) ? previous : { ...previous, [tabId]: [...ids, containerId] };
        });
    }, []);

    const { liveVisibleNodes, liveVisibleEdges, liveActive, unresolvedStates,
        runtimeParallelViews, runtimeActiveSubMachines } = useLiveExecution({
        liveExecution: runtimeLog ? null : liveExecution,
        onOpenSubMachine: handleOpenSubMachine,
        onExpandContainer: expandRuntimeContainer,
        tabs,
        activeTabId,
        activeDocumentGeneration: activeWorkflowTab?.documentGeneration,
        activeFingerprint: activeWorkflowFingerprint,
        visibleNodes: playbackVisibleNodes,
        visibleEdges: playbackVisibleEdges,
        fitView,
        getViewport,
        setViewport,
        switchTab,
        getActiveDocumentIdentity,
        suspendFollow: isDraggingNode || drawerData.isOpen || activeMode === "code" || isHintPageOpen
            || isCreateSlotModalOpen || Boolean(documentGuard || pendingSubMachineCreation
                || pendingSlotRename || stateMachineLoading || runtimePreparation || contextMenu),
    });

    const {
        handleLibraryDragOver,
        handleLibraryDragLeave,
        handleLibraryDrop,
        handleAddLibrarySkill,
        libraryDropError,
        dismissLibraryDropError,
    } = useEditorLibraryDrop({
        activeMode,
        nodes,
        flowContainerRef,
        getTabSnapshot,
        getActiveDocumentIdentity,
        getDocumentSnapshot,
        screenToFlowPosition,
        setParallelDropTargetId,
        setCompoundDropTargetId,
        createBehaviorNode,
        createNode,
        checkSlotConnection,
        setNodes,
        updateGraph,
        setManualSlots,
        setSelectedNodeId,
        setRightPanelTab,
        syncInsertedEditorStatesAfterCommit:
            rustWorkflowDocument.syncInsertedEditorStatesAfterCommit,
        syncInsertedParallelLaneStateAfterCommit:
            rustWorkflowDocument.syncInsertedParallelLaneStateAfterCommit,
        syncSlotsAfterCommit: rustWorkflowDocument.syncSlotsAfterCommit,
        onParallelSkillConflict: (message) => notify({ tone: "danger", message, id: "parallel-lane-duplicate", duration: 2300 }),
    });

    // Library insertion selects the new node but never opens the inspector.
    const addLibrarySkill = handleAddLibrarySkill;

    const {
        isShortcutHelpOpen,
        setIsShortcutHelpOpen,
    } = useGlobalEditorShortcuts({
        activeMode,
        setActiveMode,
        activeTabId,
        contextMenu,
        setContextMenu,
        isDrawerOpen: drawerData.isOpen,
        setDrawerData,
        isCreateSlotModalOpen,
        setIsCreateSlotModalOpen,
        isFindOpen,
        setIsFindOpen,
        nodes,
        slotNodes,
        fitView,
        clearAllEdgeSelection,
        clearEditorNodeSelection,
        handleAddNewTab,
        handleCloseTab,
        canGoFocusBack,
        canGoFocusForward,
        goFocusBack,
        goFocusForward,
    });

    const selectLibraryPackage = useCallback((pkg) => {
        setSelectedPackage(pkg);
        setSelectedSubPackage(null);
    }, [setSelectedPackage, setSelectedSubPackage]);
    const reloadSkills = useCallback(() => fetchSkills({ manual: true }), [fetchSkills]);

    const selectedSkillOutgoingTransitions = useMemo(() => {
        if (!selectedNode || selectedNode.type === "compound" || selectedNode.type === "parallel") return [];
        return edges.filter((edge) =>
            !edge.data?.boundaryInternalEdge && !edge.data?.compoundInternalEdge &&
            !edge.data?.parallelInternalEdge && getLogicalEdgeSourceId(edge) === selectedNode.id
        ).map((edge) => {
            const eventId = getLogicalEdgeSourceHandle(edge);
            const matchingEvent = (selectedNode.data?.events || []).find((event) =>
                event.id === eventId && event.target === edge.target &&
                String(event.cond || "") === String(edge.data?.cond || "")
            ) || (selectedNode.data?.events || []).find((event) =>
                event.id === eventId && event.target === edge.target
            );
            return {
                edgeId: edge.id, sourceNodeId: selectedNode.id,
                eventId, targetNodeId: edge.target,
                cond: edge.data?.cond || matchingEvent?.cond || "",
                assignments: getStoredTransitionAssignments(edge.data).length
                    ? getStoredTransitionAssignments(edge.data)
                    : getStoredTransitionAssignments(matchingEvent),
            };
        });
    }, [edges, selectedNode]);

    // These are shared exits owned by a surrounding container, not additional
    // outgoing transitions of the selected skill. Keep them separate from the
    // mutable transition list and compute only when graph semantics change.
    const selectedSkillSharedExits = useMemo(() => {
        if (!selectedNode || !["custom", "submachine"].includes(selectedNode.type)) return [];
        return getSharedContainerExitsForSkill(selectedNode.id, semanticNodes, edges);
    }, [selectedNode?.id, selectedNode?.type, semanticNodes, edges]);

    const selectedContainerTransitionDetails = useMemo(() => {
        if (!selectedContainerOutgoingTransitions.length) return selectedContainerOutgoingTransitions;
        const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        return selectedContainerOutgoingTransitions.map((transition) => {
            const edge = edgeById.get(transition.edgeId);
            const source = nodeById.get(transition.sourceNodeId);
            const matchingEvent = (source?.data?.events || []).find((event) =>
                event.id === transition.eventId && event.target === transition.targetNodeId &&
                String(event.cond || "") === String(edge?.data?.cond || "")
            ) || (source?.data?.events || []).find((event) =>
                event.id === transition.eventId && event.target === transition.targetNodeId
            );
            return {
                ...transition,
                cond: edge?.data?.cond || matchingEvent?.cond || "",
                assignments: getStoredTransitionAssignments(edge?.data).length
                    ? getStoredTransitionAssignments(edge?.data)
                    : getStoredTransitionAssignments(matchingEvent),
            };
        });
    }, [selectedContainerOutgoingTransitions, edges, nodes]);

    const detailsCallbacks = useEditorDetailsCallbacks({
        onNavigateCloneSource: handleNavigateCloneSource,
        onNavigateClone: handleNavigateCloneSource,
        onMoveContainerTransition: handleMoveContainerTransition,
        onNavigateTransitionNode: handleNavigateCloneSource,
        onHoverTransitionNode: hoverTransitionNode,
        onHoverTransitionEdge: hoverTransitionBadge,
        onOpenTransitionPanel: (sourceNodeId, eventId, targetNodeId = null, options = null) => {
            if (!sourceNodeId || (!options?.containerMode && !eventId)) return;
            openConditionDrawer(sourceNodeId, eventId, targetNodeId || null, null, options);
        },
        onAddParallelLane: () => handleAddLaneToParallel(selectedNode.id),
        onRenameParallelLane: (laneId, name) => handleRenameParallelLane(selectedNode.id, laneId, name),
        onMoveParallelLane: (laneId, direction) => handleMoveParallelLane(selectedNode.id, laneId, direction),
        onDeleteParallelLane: (laneId) => handleDeleteParallelLane(selectedNode.id, laneId),
        onSetInitial: () => setNodeAsInitial(selectedNode.id),
        onUpdateName: (name) => updateNodeName(selectedNode.id, name, false),
        onUpdateNameCommit: (name) => updateNodeName(selectedNode.id, name, true),
        onUpdateSrc: updateNodeSource,
        onUpdateEvent: updateNodeEvent,
        onSetEventTarget: setExistingTargetForEvent,
        getParameterEditSource: getNodeParameterEditSource,
        onUpdateParameter: (index, value, commit = false, source) =>
            updateNodeParameter(source?.nodeId || selectedNode.id, index, value, commit, source),
        onUpdateStateActions: updateStateActions,
        onUpdateSendEvents: updateSendEvents,
        onUpdateInSlotPath: (index, value, commit = false) => updateSkillSlotPath(selectedNode.id, "read", index, value, commit),
        onUpdateOutSlotPath: (index, value, commit = false) => updateSkillSlotPath(selectedNode.id, "write", index, value, commit),
        onUpdateSlotPath: handleUpdateSelectedSlotPath,
        onUpdateSlotInherited: handleUpdateSelectedSlotInherited,
        onHoverSlotAccessSkill: (nodeId) => setHoveredSlotAccessNodeId(nodeId || null),
        onSelectSlotAccessSkill: handleSelectSlotAccessSkill,
        onNavigateDescendantSlotSkill: handleNavigateDescendantSlotSkill,
        onNavigateAncestorSlot: handleNavigateAncestorSlot,
    });

    const runtimeTimelineSkill = useMemo(() => {
        if (!selectedRuntimeFrame || !liveRunRef.current?.workflow) return null;
        const state = selectedRuntimeFrame.state || selectedRuntimeFrame.transition?.source || "";
        const tabsForRun = [...new Map([...(liveRunRef.current.tabsSnapshot || []), ...tabs]
            .map((tab) => [tab.id, tab])).values()];
        const match = resolveRuntimeSkill(liveRunRef.current.workflow, tabsForRun, state);
        return match ? { ...match, state } : null;
    }, [selectedRuntimeFrame?.id, activeTabId, tabs]);

    const runtimeConfiguredSlots = useMemo(() => {
        const all = [...nodes, ...tabs.flatMap((tab) => tab.nodes || [])];
        const seen = new Map();
        for (const node of all) {
            for (const slot of configuredSkillSlots(node)) {
                if (slot.path && !seen.has(slot.path)) seen.set(slot.path, slot);
            }
        }
        for (const slot of slotNodes || []) {
            const path = normalizeMemoryPath(slot.data?.path || slot.data?.label);
            if (path && !seen.has(path)) seen.set(path, {
                path, key: slot.data?.label || path, access: "read/write", type: "",
            });
        }
        return [...seen.values()];
    }, [nodes, tabs, slotNodes]);

    const canvasRuntimeNodes = useMemo(() => {
        if (runtimeLog || !selectedRuntimeFrame) return liveVisibleNodes;
        const slots = {};
        for (const node of liveVisibleNodes) {
            if (node.type !== "slot") continue;
            const path = normalizeMemoryPath(node.data?.path || node.data?.label);
            if (!path) continue;
            const item = runtimeEventTimeline.watching ? runtimeMemory.live[path]
                : historicalSlotValue(runtimeMemory.observations, selectedRuntimeFrame, path, runtimeMemory.writes, runtimeMemory.skillExecutions);
            if (item?.status === "available") slots[path] = {
                value: item.value, timestamp: item.observedAt || (item.stale ? "Stale" : "live"),
                dataType: item.type, stale: Boolean(item.stale),
            };
        }
        return decorateLiveRuntimeNodes(liveVisibleNodes, { ...selectedRuntimeFrame, slots });
    }, [runtimeLog, liveActive, liveVisibleNodes, selectedRuntimeFrame,
        runtimeEventTimeline.watching, runtimeMemory.live, runtimeMemory.observations, runtimeMemory.writes, runtimeMemory.skillExecutions]);

    // Diagnostic only: prove whether replay resolved the value and whether the
    // decorated React Flow slot node actually received runtimeSlotValueMeta.
    useEffect(() => {
        if (!selectedRuntimeFrame || runtimeEventTimeline.watching) return;
        const linked = observationForRuntimeFrame(runtimeMemory.observations, selectedRuntimeFrame);
        const nodesToCheck = liveVisibleNodes.filter((node) => node.type === "slot");
        const checks = nodesToCheck.map((node) => {
            const path = normalizeMemoryPath(node.data?.path || node.data?.label);
            const chosen = historicalSlotValue(runtimeMemory.observations, selectedRuntimeFrame, path, runtimeMemory.writes, runtimeMemory.skillExecutions);
            const decorated = canvasRuntimeNodes.find((item) => item.id === node.id);
            return { nodeId: node.id, rawPath: node.data?.path || node.data?.label || "",
                normalizedPath: path, selected: summarizeSlot(chosen),
                nodeRuntimeValue: decorated?.data?.runtimeSlotValueMeta || null,
                linkedPaths: linked ? [...(linked.slots || []), ...(linked.cache || [])].map((item) => item.path) : null };
        });
        const signature = JSON.stringify({ frame: selectedRuntimeFrame.id, count: runtimeMemory.observations.length,
            checks, linkedSequence: linked?.sequence });
        traceSlot("replay.canvas", { frameId: selectedRuntimeFrame.id,
            frameType: selectedRuntimeFrame.type, frameState: selectedRuntimeFrame.state,
            frameSequence: selectedRuntimeFrame.sequence, framePerf: selectedRuntimeFrame.receivedAtPerf,
            captureMatched: Boolean(linked), captureState: linked?.state || null,
            captureEntrySequence: linked?.entrySequence ?? null,
            capturedPaths: linked?.cache?.map(summarizeSlot) ?? null,
            observations: runtimeMemory.observations.length, checks }, signature);
    }, [selectedRuntimeFrame, runtimeEventTimeline.watching, runtimeMemory.observations, runtimeMemory.writes, runtimeMemory.skillExecutions,
        liveVisibleNodes, canvasRuntimeNodes]);

    return (
        <div className="container">
            <Header
                onOpenFile={handleOpenDocument}
                onSaveFile={handleSaveCurrentTab}
                onSaveAsFile={handleSaveAsCurrentTab}
                hasFilePath={activeWorkflowHasFilePath}
                isSaving={isWorkflowSaving}
                isOpening={isWorkflowOpening}
                panels={panels}
                runtimeAssignmentsVisible={isRuntimeCommanderOpen}
                runtimeAssignmentsOpen={runtimeAssignmentsOpen}
                onToggleRuntimeAssignments={toggleRuntimeAssignments}
                showTransitionEdges={showTransitionEdges}
                onToggleTransitionEdges={() => setShowTransitionEdges((value) => !value)}
                showSlotEdges={showSlotEdges}
                onToggleSlotEdges={() => setShowSlotEdges((value) => !value)}
                showCodeViewButton={showCodeViewButton}
                onToggleCodeViewButton={() => {
                    // Do not leave Code View active with its entry button hidden.
                    if (showCodeViewButton && activeMode === "code") setActiveMode("overview");
                    setShowCodeViewButton((value) => !value);
                }}
                colorblindMode={colorblindMode}
                onToggleColorblindMode={() => setColorblindMode((value) => !value)}
            />
            <EditorNotice notice={documentNotice} onDismiss={dismissDocumentNotice}
                onRetry={handleRetryDocumentAction}
                onSaveAs={() => handleRetryDocumentAction({ forceSaveAs: true })} />
            <EditorNotice notice={libraryDropError} onDismiss={dismissLibraryDropError} />

            <div className="app" data-panel-mode={panels.isDocked ? "docked" : "drawers"}
                data-library-dragging={String(panels.libraryDragging)} data-panel-resizing={String(panels.resizing)}
                style={{
                    "--library-width": `${panels.libraryWidth}px`,
                    "--inspector-width": `${panels.inspectorWidth}px`,
                    "--library-drawer-width": `${Math.min(panels.preferences.libraryWidth, panels.libraryMaxWidth)}px`,
                    "--inspector-drawer-width": `${Math.min(panels.preferences.inspectorWidth, panels.inspectorMaxWidth)}px`,
                    "--library-resize-width": panels.isDocked && panels.libraryOpen ? "6px" : "0px",
                    "--inspector-resize-width": panels.isDocked && (panels.inspectorOpen || assignmentsVisible) ? "6px" : "0px",
                    // Inspector and Run Assignments share one right-hand dock width.
                    // No collapsed track is reserved merely to hold the ledges.
                    "--right-dock-width": runtimeAssignmentsOpen && (isRuntimeCommanderOpen || runtimeEventTimeline.frames.length > 0)
                        ? `${effectiveAssignmentsWidth}px`
                        : panels.isDocked && panels.inspectorOpen ? `${panels.inspectorWidth}px` : "0px",
                }}>
                <EditorPanel side="library" panels={panels}>
                {leftLibraryTab === "skills" ? (
                    <SkillLibrary
                        searchText={searchText}
                        setSearchText={setSearchText}
                        activeFilter={activeFilter}
                        setActiveFilter={setActiveFilter}
                        packages={packages}
                        selectedPackage={selectedPackage}
                        setSelectedPackage={selectLibraryPackage}
                        searchedSkills={searchedSkills}
                        packageSkills={packageSkills}
                        filteredSkills={filteredSkills}
                        subPackages={subPackages}
                        selectedSubPackage={selectedSubPackage}
                        setSelectedSubPackage={setSelectedSubPackage}
                        directSkills={directSkills}
                        activeLibraryTab={leftLibraryTab}
                        onLibraryTabChange={setLeftLibraryTab}
                        onReloadSkills={reloadSkills}
                        isReloadingSkills={isReloadingSkills}
                        refreshVersion={skillLibraryRefreshVersion}
                        skillLibraryStatus={skillLibraryStatus}
                        skillLibraryError={skillLibraryError}
                        hasLoadedSkills={hasLoadedSkills}
                        skillCount={skills.skills.length}
                        fetchSkillData={fetchSkillData}
                        onAddSkill={addLibrarySkill}
                        canAddSkill={activeMode !== "code"}
                    />
                ) : (
                    <BehaviorLibrary
                        directories={behaviorDirectories}
                        onDirectoriesChange={setBehaviorDirectories}
                        onOpenBehavior={handleOpenBehaviorFile}
                        activeLibraryTab={leftLibraryTab}
                        onLibraryTabChange={setLeftLibraryTab}
                    />
                )}
                </EditorPanel>
                <EditorPanelResizer side="library" panels={panels} />

                <main className="editor-area">
                    <WorkflowTabBar
                        tabs={tabs}
                        activeTabId={activeTabId}
                        draggedTabId={draggedTabId}
                        switchTab={switchTab}
                        handleTabDragStart={handleTabDragStart}
                        handleTabDragOver={handleTabDragOver}
                        handleTabDragEnd={handleTabDragEnd}
                        handleTabMiddleMouseDown={handleTabMiddleMouseDown}
                        handleTabMouseEnter={handleTabMouseEnter}
                        handleTabMouseLeave={handleTabMouseLeave}
                        handleCloseTab={handleCloseTab}
                        handleAddNewTab={handleAddNewTab}
                        canGoFocusBack={canGoFocusBack}
                        canGoFocusForward={canGoFocusForward}
                        onFocusBack={goFocusBack}
                        onFocusForward={goFocusForward}
                    />

                    <EditorFindOverlay
                        isOpen={isFindOpen}
                        panelRef={findPanelRef}
                        inputRef={findInputRef}
                        query={findQuery}
                        setQuery={setFindQuery}
                        results={findResults}
                        resultIndex={findResultIndex}
                        setResultIndex={setFindResultIndex}
                        focusResult={focusFindResult}
                        onClose={() => setIsFindOpen(false)}
                    />

                    <div
                        ref={flowContainerRef}
                        id="workflow-tab-panel"
                        role="tabpanel"
                        aria-labelledby={`workflow-tab-${activeTabId}`}
                        tabIndex={0}
                        className="flow-container"
                        onPointerMove={(event) => {
                            editorPointerPositionRef.current = {
                                inside: true,
                                clientX: event.clientX,
                                clientY: event.clientY,
                            };
                        }}
                        onPointerLeave={() => {
                            editorPointerPositionRef.current = {
                                inside: false,
                                clientX: null,
                                clientY: null,
                            };
                        }}
                        onDragOver={handleLibraryDragOver}
                        onDragLeave={handleLibraryDragLeave}
                        onDrop={handleLibraryDrop}
                    >
                        <EditorCanvas
                            activeMode={activeMode}
                            setActiveMode={setActiveMode}
                            showTransitionEdges={showTransitionEdges}
                            showSlotEdges={showSlotEdges}
                            showCodeViewButton={showCodeViewButton}
                            colorblindMode={colorblindMode}
                            nodes={nodes}
                            edges={edges}
                            globalDataModel={globalDataModel}
                            manualSlots={manualSlots}
                            visibleNodes={canvasRuntimeNodes}
                            visibleEdges={liveVisibleEdges}
                            documentKey={`${activeTabId}:${activeWorkflowTab?.documentGeneration ?? 0}`}
                            liveExecutionActive={liveActive}
                            smartRoutingNodes={smartRoutingNodes}
                            edgeFocusMode={edgeFocusMode}
                            nodeFocusMode={nodeFocusMode}
                            contextMenu={contextMenu}
                            setContextMenu={setContextMenu}
                            handleSelectAction={handleSelectAction}
                            hasGraphClipboard={hasGraphClipboard}
                            slotConnectionDrag={slotConnectionDrag}
                            isDraggingNode={isDraggingNode || Boolean(resizingContainerId)}
                            isOverTrash={isOverTrash}
                            handleNodesChange={handleNodesChange}
                            handleVisibleEdgesChange={handleVisibleEdgesChange}
                            onSelectionChange={handleGraphSelectionChange}
                            onConnect={onConnect}
                            handleConnectStart={handleConnectStart}
                            handleConnectEnd={handleConnectEnd}
                            onReconnect={onReconnect}
                            handleReconnectStart={handleReconnectStart}
                            handleReconnectEnd={handleReconnectEnd}
                            isValidConnection={isValidConnection}
                            handleEdgeClick={handleEdgeClick}
                            handleEdgeDoubleClick={handleEditorEdgeDoubleClick}
                            handleNodeClick={(...args) => { setRuntimeManualSkillSelection(true); handleNodeClick(...args); }}
                            handleNodeDoubleClick={handleNodeDoubleClick}
                            handlePaneClick={handlePaneClick}
                            handleNodeMouseEnter={handleNodeMouseEnter}
                            handleNodeMouseLeave={handleNodeMouseLeave}
                            handleEdgeMouseEnter={handleEdgeMouseEnter}
                            handleEdgeMouseLeave={handleEdgeMouseLeave}
                            handleContextMenuOpen={handleContextMenuOpen}
                            handleOpenSubMachine={handleOpenSubMachine}
                            handleNodeDragStart={handleNodeDragStart}
                            handleNodeDrag={handleNodeDrag}
                            handleNodeDragStop={handleNodeDragStop}
                            runtimePlayback={runtimePlayback}
                            runtimeCommanderOpen={isRuntimeCommanderOpen}
                            runtimeExpansionActive={Boolean(runtimeExpandedContainers[activeTabId]?.length)}
                            onOpenRuntimeCommander={() => setIsRuntimeCommanderOpen(true)}
                            onLoadRuntimeLog={handleLoadRuntimeLog}
                            onRuntimePlayPause={toggleRuntimePlayback}
                            onRuntimeRestart={restartRuntimePlayback}
                            onRuntimePrevious={() => stepRuntimePlayback(-1)}
                            onRuntimeNext={() => stepRuntimePlayback(1)}
                            onRuntimeSeek={seekRuntimePlayback}
                            onRuntimeClear={handleClearRuntimeLog}
                            onRuntimeDelayChange={setRuntimePlaybackDelay}
                        />

                    </div>
                    <RunLogPanel session={runLogSession} />
                    <EditorUtilityBar onQuickGuide={() => setIsHintPageOpen(true)}
                        shortcuts={{ isOpen: isShortcutHelpOpen, setIsOpen: setIsShortcutHelpOpen }}
                        onRefresh={refreshEditorNodes} canRefresh={activeMode !== 'code'} />
                </main>

                {assignmentsVisible ? <div role="separator" aria-orientation="vertical"
                    aria-label="Resize run assignments" aria-controls="runtime-assignments-panel"
                    aria-valuemin={Math.round(minAssignmentsWidth)} aria-valuemax={Math.round(maxAssignmentsWidth)}
                    aria-valuenow={Math.round(effectiveAssignmentsWidth)}
                    tabIndex={panels.isDocked ? 0 : -1} aria-hidden={!panels.isDocked}
                    className="editor-panel-resize editor-panel-resize-assignments"
                    data-open={String(panels.isDocked)}
                    onPointerDown={startAssignmentsResize} onPointerMove={moveAssignmentsResize}
                    onPointerUp={finishAssignmentsResize} onPointerCancel={finishAssignmentsResize}
                    onLostPointerCapture={finishAssignmentsResize} onKeyDown={keyAssignmentsResize}
                    onDoubleClick={() => setRunAssignmentsWidth(null)}
                    title="Drag or use arrow keys to resize Run assignments; double-click to reset" />
                    : <EditorPanelResizer side="inspector" panels={panels} />}
                <EditorPanel side="inspector" panels={panels}>
                    <EditorInspectorPanel
                        rightPanelTab={rightPanelTab}
                        setRightPanelTab={setRightPanelTab}
                        selection={{
                            selectedNode,
                            cloneSourceNode: selectedCloneSourceNode,
                            cloneNodes: selectedNodeClones,
                            containerOutgoingTransitions: selectedContainerTransitionDetails,
                            skillOutgoingTransitions: selectedSkillOutgoingTransitions,
                            skillSharedExits: selectedSkillSharedExits,
                            parallelLanes: selectedParallelLanes,
                            hasInitialNode,
                            actionDataModel: selectedActionDataModel,
                            actionExpressionVariables: selectedActionExpressionVariables,
                            slotDetails: selectedSlotDetails,
                        }}
                        dataModel={{
                            global: globalDataModel,
                            inherited: inheritedGlobalDataModel,
                            descendant: descendantGlobalDataModel,
                            onUpdateParameter: updateGlobalParameter,
                            onAddParameter: addGlobalParameter,
                            onDeleteParameter: deleteGlobalParameter,
                        }}
                        problems={{
                            items: editorProblems,
                            status: validationStatus,
                            errorCount: errorProblemCount,
                            onClick: handleProblemClick,
                        }}
                        runtime={{
                            log: runtimeLog,
                            panelOpen: runtimeChangesPanelOpen,
                            setPanelOpen: setRuntimeChangesPanelOpen,
                            playback: runtimePlayback,
                            changes: activeRuntimeChanges,
                        }}
                        details={{
                            callbacks: detailsCallbacks,
                            activeTab,
                            setActiveTab,
                            availableTargetNodes: semanticNodes,
                            availableSlotPaths: canvasSlotPathOptions,
                            parameterFocusRequest,
                            slotFocusRequest,
                            transitionFocusRequest,
                        }}
                    />
                </EditorPanel>
                <EditorPanelLedge side="library" panels={panels} />
                <div className="right-panel-ledges" aria-label="Right sidebar tabs">
                    <EditorPanelLedge side="inspector" panels={panels} />
                    {(isRuntimeCommanderOpen || runtimeEventTimeline.frames.length > 0) && <RuntimeAssignmentsLedge open={runtimeAssignmentsOpen}
                        onToggle={toggleRuntimeAssignments} />}
                </div>
                {(isRuntimeCommanderOpen || runtimeEventTimeline.frames.length > 0) && <RuntimeAssignmentsDrawer timeline={runtimeEventTimeline} frame={selectedRuntimeFrame}
                    memory={runtimeMemory}
                    configuredSlots={runtimeConfiguredSlots}
                    selectedSkill={runtimeManualSkillSelection ? selectedNode : runtimeTimelineSkill?.node || selectedNode}
                    selectedSkillState={runtimeManualSkillSelection ? null : runtimeTimelineSkill?.state}
                    declaredVariables={[...(inheritedGlobalDataModel || []), ...(globalDataModel || [])]}
                    onSeek={(index) => { setRuntimeManualSkillSelection(false); seekRuntimeEvent(index); }}
                    onLive={goLiveRuntimeEvent} open={runtimeAssignmentsOpen} />}
                {!panels.isDocked && panels.drawer && !panels.libraryDragging && (
                    <button type="button" className="editor-panel-backdrop" tabIndex={-1}
                        aria-label="Close side panel" onClick={() => panels.closePanel(panels.drawer)} />
                )}
            </div>

            <EditorOverlays
                runtimeCommander={{
                    isOpen: isRuntimeCommanderOpen,
                    onClose: () => {
                        setIsRuntimeCommanderOpen(false);
                        setRuntimeAssignmentsOpen(false);
                    },
                    onRuntimeStarted: showRuntimeAssignments,
                    workflowTab: activeWorkflowTab,
                    workflowFingerprint: activeWorkflowFingerprint,
                    getTabSnapshot,
                    getTabsSnapshot,
                    getActiveDocumentIdentity,
                    onExecutionUpdate: handleExecutionUpdate,
                    onRuntimeEvent: handleRuntimeEvent,
                    onRuntimeReset: handleRuntimeReset,
                    onLogLoadRequested: handleRunLogLoad,
                    onRuntimeGap: handleRuntimeGap,
                    onRuntimeBackendRestart: handleRuntimeReset,
                    onRuntimeBaseline: seedRuntimeBaseline,
                    runtimeTimeline: runtimeEventTimeline,
                    selectedRuntimeFrame,
                    onRuntimeSeek: (index) => { setRuntimeManualSkillSelection(false); seekRuntimeEvent(index); },
                    onRuntimeLive: goLiveRuntimeEvent,
                    unresolvedStates,
                    runtimeParallelViews,
                    runtimeActiveSubMachines,
                    onOpenRuntimeSubMachine: handleOpenSubMachine,
                    behaviorDirectories,
                }}
                slotRename={pendingSlotRename ? {
                    pending: pendingSlotRename,
                    onCancel: cancelSlotRename,
                    onConfirm: () => confirmSlotRename(pendingSlotRename.id),
                } : null}
                documentGuard={documentGuard}
                loading={stateMachineLoading}
                runtimePreparation={runtimePreparation}
                hint={{ isOpen: isHintPageOpen, onClose: () => setIsHintPageOpen(false) }}
                subMachine={{
                    pending: pendingSubMachineCreation,
                    onCancel: () => setPendingSubMachineCreation(null),
                    onConfirm: (fileConfig) => {
                        if (!pendingSubMachineCreation) return false;
                        return pendingSubMachineCreation.fromSelection
                            ? handleCreateSubMachineFromSelected(fileConfig)
                            : handleCreateEmptySubMachine(pendingSubMachineCreation.flowPosition, fileConfig);
                    },
                }}
                tabPathTooltip={tabPathTooltip}
                condition={{
                    drawer: drawerData,
                    liveCandidateTransitions: liveDrawerData?.candidateTransitions,
                    sharedContainerExits: liveDrawerData?.sharedContainerExits || drawerData.sharedContainerExits || [],
                    variables: availableDataModelParameters,
                    onAddParameter: addGlobalParameter,
                    graphEdges: edges,
                    onConfirm: (...args) => {
                        hoverTransitionEdge(null);
                        return handleConfirmDrawer(...args);
                    },
                    onHoverTransitionEdge: hoverTransitionBadge,
                    onClose: () => {
                        hoverTransitionEdge(null);
                        setDrawerData((prev) => ({ ...prev, isOpen: false }));
                        clearTransitionSelection();
                    },
                }}
                slots={{
                    isOpen: isCreateSlotModalOpen,
                    onClose: () => setIsCreateSlotModalOpen(false),
                    onCreate: createManualSlot,
                    options: canvasSkillSlotOptions,
                }}
            />
        </div>
    );
}

export default function App() {
    return (
        <FeedbackProvider>
            <ReactFlowProvider>
                <AppContent />
            </ReactFlowProvider>
        </FeedbackProvider>
    );
}
