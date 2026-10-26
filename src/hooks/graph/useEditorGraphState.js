import { useCallback, useEffect, useRef, useState } from "react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { applyGraphTransaction } from "../../utils/graphTransaction.js";
import { followParallelResizeGesture, reconcileMeasuredParallelLanes } from "../../utils/containerState.js";
import { isMovingPositionBatch, collectDraggedPositions } from "../../utils/dragPositionBatch.js";
import { traceResizeNodeChanges, traceResizeNodeMutation } from "../../utils/resizeDiagnostics.js";

const createStatePrefixDeclaration = () => [
    { id: "#_STATE_PREFIX", expr: "'de.unibi.citec.clf.bonsai.skills.'" },
];

export function useEditorGraphState() {
    const [document, setDocument] = useState(() => ({
        nodes: [],
        edges: [],
        slotNodes: [],
        slotEdges: [],
        manualSlots: [],
        globalDataModel: createStatePrefixDeclaration(),
        inheritedGlobalDataModel: [],
    }));
    const documentRef = useRef(document);

    const setField = useCallback((field, valueOrUpdater) => {
        const current = documentRef.current;
        const value =
            typeof valueOrUpdater === "function" ? valueOrUpdater(current[field]) : valueOrUpdater;
        if (value === current[field]) return;
        if (field === 'nodes') traceResizeNodeMutation('document:setNodes', current.nodes, value);
        const next = { ...current, [field]: value };
        // Publish edits before React paints them so async document actions
        // cannot approve a stale checkpoint from the previous render.
        documentRef.current = next;
        setDocument(next);
    }, []);
    // One synchronous read/compute/publish for edits that change multiple graph
    // collections. React (and document consumers) must never observe a new
    // containment tree with old boundary edges or vice versa.
    const updateGraph = useCallback((updater) => {
        const next = applyGraphTransaction(documentRef.current, updater);
        if (next === documentRef.current) return;
        traceResizeNodeMutation('document:updateGraph', documentRef.current.nodes, next.nodes);
        documentRef.current = next;
        setDocument(next);
    }, []);
    const setNodes = useCallback((value) => setField("nodes", value), [setField]);
    const setEdges = useCallback((value) => setField("edges", value), [setField]);
    const setSlotNodes = useCallback((value) => setField("slotNodes", value), [setField]);
    const setSlotEdges = useCallback((value) => setField("slotEdges", value), [setField]);
    const setManualSlots = useCallback((value) => setField("manualSlots", value), [setField]);
    const setGlobalDataModel = useCallback(
        (value) => setField("globalDataModel", value),
        [setField],
    );
    const setInheritedGlobalDataModel = useCallback(
        (value) => setField("inheritedGlobalDataModel", value),
        [setField],
    );
    // React Flow emits many intermediate pointer positions during a drag.
    // Every immediate publish previously invalidated App and all graph
    // projections (even though semantic edges/parentage did not change).
    // Keep only the latest position per node and publish at most once per
    // animation frame. Structural/selection changes still commit immediately.
    const pendingDraggedPositionsRef = useRef(new Map());
    const pendingDragFrameRef = useRef(null);
    const flushPendingNodeChanges = useCallback(() => {
        if (pendingDragFrameRef.current !== null) {
            cancelAnimationFrame(pendingDragFrameRef.current);
            pendingDragFrameRef.current = null;
        }
        const positions = [...pendingDraggedPositionsRef.current.values()];
        pendingDraggedPositionsRef.current.clear();
        if (positions.length) {
            setNodes((nodes) => applyNodeChanges(positions, nodes));
        }
    }, [setNodes]);
    useEffect(() => () => {
        if (pendingDragFrameRef.current !== null) cancelAnimationFrame(pendingDragFrameRef.current);
        pendingDragFrameRef.current = null;
        pendingDraggedPositionsRef.current.clear();
    }, []);
    const onNodesChange = useCallback((changes) => {
        traceResizeNodeChanges(changes);
        if (isMovingPositionBatch(changes)) {
            collectDraggedPositions(pendingDraggedPositionsRef.current, changes);
            if (pendingDragFrameRef.current === null) {
                pendingDragFrameRef.current = requestAnimationFrame(flushPendingNodeChanges);
            }
            return;
        }
        // The final position, dimensions or a deletion must never overtake a
        // queued frame. In particular, commit the final geometry before the
        // drag-stop handler reads the document for containment/SCXML sync.
        flushPendingNodeChanges();
        setNodes((nodes) => {
            let next = applyNodeChanges(changes, nodes);
            // Keep structural lane frames in step with the parallel rectangle
            // in the *same* document publication as React Flow's dimensions.
            // No edge rebuild / descendant sizing is performed while dragging.
            for (const change of changes) {
                if (change.type !== "dimensions" || change.resizing !== true ||
                    !change.dimensions || !nodes.some((node) =>
                        node.id === change.id && node.type === "parallel")) continue;
                next = followParallelResizeGesture(next, change.id,
                    Number(change.dimensions.width), Number(change.dimensions.height));
            }
            // A mode change can remeasure a skill after its lane was laid out.
            // Reflow only the affected parallel branches, after applying those
            // new dimensions; never do expensive fitting during live resizing.
            const remeasuredIds = changes
                .filter((change) => change.type === "dimensions" &&
                    change.resizing !== true && change.dimensions)
                .map((change) => change.id);
            if (remeasuredIds.length) {
                next = reconcileMeasuredParallelLanes(next, remeasuredIds);
            }
            return next;
        });
    }, [setNodes, flushPendingNodeChanges]);
    const onEdgesChange = useCallback(
        (changes) => setEdges((edges) => applyEdgeChanges(changes, edges)),
        [setEdges],
    );
    const onSlotNodesChange = useCallback(
        (changes) => setSlotNodes((nodes) => applyNodeChanges(changes, nodes)),
        [setSlotNodes],
    );
    const onSlotEdgesChange = useCallback(
        (changes) => setSlotEdges((edges) => applyEdgeChanges(changes, edges)),
        [setSlotEdges],
    );
    const getDocumentSnapshot = useCallback(() => documentRef.current, []);

    const replaceDocument = useCallback((nextDocument = {}) => {
        // A workflow/tab replacement invalidates queued pointer positions.
        // They belong to the old document and must never be replayed into it.
        if (pendingDragFrameRef.current !== null) {
            cancelAnimationFrame(pendingDragFrameRef.current);
            pendingDragFrameRef.current = null;
        }
        pendingDraggedPositionsRef.current.clear();
        const next = {
            nodes: nextDocument.nodes || [],
            edges: nextDocument.edges || [],
            slotNodes: nextDocument.slotNodes || [],
            slotEdges: nextDocument.slotEdges || [],
            manualSlots: nextDocument.manualSlots || [],
            globalDataModel: nextDocument.globalDataModel || createStatePrefixDeclaration(),
            inheritedGlobalDataModel: nextDocument.inheritedGlobalDataModel || [],
        };
        documentRef.current = next;
        setDocument(next);
    }, []);

    return {
        ...document,
        setNodes,
        updateGraph,
        onNodesChange,
        flushPendingNodeChanges,
        setEdges,
        onEdgesChange,
        setSlotNodes,
        onSlotNodesChange,
        setSlotEdges,
        onSlotEdgesChange,
        setManualSlots,
        setGlobalDataModel,
        setInheritedGlobalDataModel,
        getDocumentSnapshot,
        replaceDocument,
    };
}
