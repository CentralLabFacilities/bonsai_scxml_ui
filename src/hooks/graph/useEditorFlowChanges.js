import { useCallback, useLayoutEffect, useRef } from "react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { expandSharedSlotEdgeRemovals, findSharedSlotPartner, updateSharedSlotBinding } from "../../utils/sharedSlotBindings.js";

import { rebuildBoundaryTransitions } from "../../utils/boundaryTransitions";
import { canonicalizeVisibleEdgeChanges } from "../../utils/transitionVisualOwnership.js";
import { isWildcardTransitionEvent } from "../../utils/transitionEvents";
import { cleanEventsForDeletedStates, cleanEventsForDeletedTransitions } from "../../utils/transitionDeletion";
import { getLogicalEdgeSourceId, getLogicalEdgeSourceHandle } from "../../utils/transitionSemantics";
import { getSlotPathFromNode, isSlotDeletionProtected, normalizeSlotPath } from "../../utils/editorGraph";
import {
    PARALLEL_BOTTOM_PADDING,
    PARALLEL_HEADER_HEIGHT,
} from "../../utils/editorGeometry";

/**
 * Owns the React Flow change pipeline that bridges visual graph changes back
 * into the semantic editor model. This keeps deletion/remapping bookkeeping
 * out of App while preserving the existing Rust synchronization boundaries.
 */
export function useEditorFlowChanges({
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
    manualSlots,
    getDocumentSnapshot,
    setNodes,
    updateGraph,
    setSlotEdges,
    setManualSlots,
    checkSlotConnection,
    syncSlotsAfterCommit,
    updateNodeInternals,
    syncRemovedStates,
    syncTransitionSources,
}) {
    // When a visual slot clone is deleted, its connected semantic slot edges
    // are retargeted to the canonical slot instead of disconnecting the skill.
    // React Flow may still emit a remove for the old edge afterwards; remember
    // those edge IDs so the follow-up removal can be ignored once.
    const remappedSlotCloneEdgeIdsRef = useRef(new Set());
    const protectedSlotEdgeIdsRef = useRef(new Set());

    // React Flow replaces the nodes array for every live position update. The
    // change handlers only need the full arrays for rare structural/removal
    // work, so keep the latest values in refs rather than recreating both
    // callbacks on every drag frame.
    const nodesRef = useRef(nodes);
    const slotNodesRef = useRef(slotNodes);
    const slotModelRef = useRef({ slotEdges, manualSlots });
    useLayoutEffect(() => {
        nodesRef.current = nodes;
        slotNodesRef.current = slotNodes;
        slotModelRef.current = { slotEdges, manualSlots };
    }, [nodes, slotNodes, slotEdges, manualSlots]);

    const handleNodesChange = useCallback(
        (changes) => {
            const graphChanges = [];
            const slotChanges = [];
            const live = changes.some((change) => change.type === "remove")
                ? getDocumentSnapshot?.() || { nodes: nodesRef.current, slotNodes: slotNodesRef.current, ...slotModelRef.current }
                : null;

            changes.forEach((change) => {
                if (nodeById.has(change.id) || live?.nodes.some((node) => node.id === change.id)) {
                    graphChanges.push(change);
                } else if (slotNodeIdSet.has(change.id) || live?.slotNodes.some((node) => node.id === change.id)) {
                    if (change.type === "remove" && isSlotDeletionProtected(
                        live.slotNodes.find((node) => node.id === change.id), live
                    )) {
                        (live.slotEdges || []).forEach((edge) => {
                            if (edge.source === change.id || edge.target === change.id) {
                                protectedSlotEdgeIdsRef.current.add(edge.id);
                            }
                        });
                        // React Flow emits connected-edge removals in the same
                        // deletion batch. Do not let a rejected node removal
                        // disconnect its bindings, or veto a later manual unlink.
                        queueMicrotask(() => protectedSlotEdgeIdsRef.current.clear());
                        return;
                    }
                    slotChanges.push(change);
                }
            });

            if (graphChanges.length > 0) {
                const removalChanges = graphChanges.filter(
                    (change) => change.type === "remove"
                );

                // Position/dimension/selection changes are React Flow's hot
                // path while a node is being dragged. None of the structural
                // deletion bookkeeping below is relevant for those updates,
                // yet the old implementation scanned the complete graph
                // several times on every pointer frame. Forward ordinary
                // visual changes immediately and reserve the expensive subtree
                // cleanup for actual removals.
                if (removalChanges.length === 0) {
                    onNodesChange(graphChanges);
                } else {
                    const currentNodes = live.nodes;
                    const removedNodeIds = new Set(
                        removalChanges.map((change) => change.id)
                    );

                // A Parallel must retain at least one lane. Context-menu
                // deletion already disables the final lane, but keyboard
                // multi-delete can otherwise remove every lane in one batch.
                const laneIdsByParallel = new Map();
                currentNodes.forEach((node) => {
                    if (node.type !== "parallelLane" || !node.parentId) return;
                    if (!laneIdsByParallel.has(node.parentId)) {
                        laneIdsByParallel.set(node.parentId, []);
                    }
                    laneIdsByParallel.get(node.parentId).push(node.id);
                });
                laneIdsByParallel.forEach((laneIds) => {
                    const requestedLaneRemovals = laneIds.filter((laneId) =>
                        removedNodeIds.has(laneId)
                    );
                    if (
                        laneIds.length > 0 &&
                        requestedLaneRemovals.length === laneIds.length
                    ) {
                        removedNodeIds.delete(laneIds[laneIds.length - 1]);
                    }
                });

                // React Flow can emit only the removed parent for structural
                // helpers. Expand the local removal too, not only the Rust
                // command, so deleting a Parallel lane cannot leave invisible
                // orphan children behind.
                let expandedLocalRemoval = true;
                while (expandedLocalRemoval) {
                    expandedLocalRemoval = false;
                    currentNodes.forEach((node) => {
                        if (removedNodeIds.has(node.id)) return;
                        if (node.parentId && removedNodeIds.has(node.parentId)) {
                            removedNodeIds.add(node.id);
                            expandedLocalRemoval = true;
                        }
                    });
                }

                const nonRemovalChanges = graphChanges.filter(
                    (change) => change.type !== "remove"
                );
                const effectiveGraphChanges = [
                    ...nonRemovalChanges,
                    ...[...removedNodeIds].map((id) => ({ id, type: "remove" })),
                ];

                const affectedParallelIds = new Set(
                    currentNodes
                        .filter(
                            (node) =>
                                removedNodeIds.has(node.id) &&
                                node.type === "parallelLane" &&
                                node.parentId
                        )
                        .map((node) => node.parentId)
                );

                // Node removal, semantic event cleanup, affected lane reflow,
                // and boundary edge removal are one document transaction.
                updateGraph(({ nodes: liveNodes, edges: liveEdges }) => {
                    const removedNodes = applyNodeChanges(effectiveGraphChanges, liveNodes);
                    const cleanedNodes = removedNodes.map((node) => {
                        const currentEvents = node.data?.events || [];
                        const nextEvents = cleanEventsForDeletedStates(currentEvents, removedNodeIds);
                        return nextEvents.length === currentEvents.length &&
                            nextEvents.every((event, index) => event === currentEvents[index])
                            ? node
                            : { ...node, data: { ...node.data, events: nextEvents } };
                    });
                    let nextNodes = cleanedNodes;
                    if (affectedParallelIds.size > 0) {


                            affectedParallelIds.forEach((parallelId) => {
                                const parallel = nextNodes.find(
                                    (node) => node.id === parallelId
                                );
                                if (!parallel) return;

                                const lanes = nextNodes
                                    .filter(
                                        (node) =>
                                            node.type === "parallelLane" &&
                                            node.parentId === parallelId
                                    )
                                    .sort(
                                        (a, b) =>
                                            Number(a.position?.y || 0) -
                                            Number(b.position?.y || 0)
                                    );
                                if (lanes.length === 0) return;

                                let nextY = PARALLEL_HEADER_HEIGHT;
                                const laneUpdates = new Map();
                                lanes.forEach((lane, index) => {
                                    const laneHeight = Math.max(
                                        90,
                                        Number(lane.style?.height) || 140
                                    );
                                    laneUpdates.set(lane.id, {
                                        y: nextY,
                                        height: laneHeight,
                                        borderBottom:
                                            index < lanes.length - 1
                                                ? "1.5px solid #0284c7"
                                                : "none",
                                    });
                                    nextY += laneHeight;
                                });

                                const parallelHeight =
                                    nextY + PARALLEL_BOTTOM_PADDING;
                                const laneNames = lanes.map(
                                    (lane, index) =>
                                        lane.data?.label || `Lane_${index + 1}`
                                );

                                nextNodes = nextNodes.map((node) => {
                                    const laneUpdate = laneUpdates.get(node.id);
                                    if (laneUpdate) {
                                        return {
                                            ...node,
                                            position: {
                                                ...node.position,
                                                x: 0,
                                                y: laneUpdate.y,
                                            },
                                            style: {
                                                ...(node.style || {}),
                                                width:
                                                    Number(parallel.style?.width) ||
                                                    Number(node.style?.width) ||
                                                    420,
                                                height: laneUpdate.height,
                                                borderBottom:
                                                    laneUpdate.borderBottom,
                                            },
                                        };
                                    }

                                    if (node.id === parallelId) {
                                        return {
                                            ...node,
                                            style: {
                                                ...(node.style || {}),
                                                height: parallelHeight,
                                            },
                                            data: {
                                                ...(node.data || {}),
                                                lanes: laneNames,
                                            },
                                        };
                                    }

                                    return node;
                                });
                            });


                    }
                    const nextEdges = liveEdges.filter((edge) => {
                        const sources = [
                            edge.source, edge.target,
                            edge.data?.boundaryOriginalSource,
                            edge.data?.compoundOriginalSource,
                            edge.data?.parallelOriginalSource,
                            edge.data?.boundaryOriginalTarget,
                            edge.data?.compoundOriginalTarget,
                            edge.data?.parallelOriginalTarget,
                            ...(edge.data?.boundaryOriginalSources || []).map(
                                (source) => source?.sourceId || source?.nodeId || source?.id
                            ),
                        ];
                        return !sources.some((id) => removedNodeIds.has(id));
                    });
                    return { nodes: nextNodes, edges: nextEdges };
                });

                if (removedNodeIds.size > 0) {
                    // React Flow may report only a removed parent while its
                    // descendants disappear with it. Expand the semantic
                    // removal set here so Rust also sees the full subtree and
                    // so slot/reference fallbacks inspect every removed state.
                    const semanticRemovalIds = new Set(removedNodeIds);

                    const removedNodes = currentNodes.filter((node) =>
                        semanticRemovalIds.has(node.id)
                    );
                    const removedReferenceNodes = removedNodes.filter(
                        (node) =>
                            node.data?.isSkillClone || node.data?.isStateClone
                    );
                    const referenceStateIds = removedReferenceNodes.map(
                        (node) => node.id
                    );
                    const referenceSourceIds = Array.from(
                        new Set(
                            removedReferenceNodes
                                .map((node) => node.data?.cloneOfNodeId)
                                .filter(
                                    (sourceId) =>
                                        sourceId &&
                                        !semanticRemovalIds.has(sourceId)
                                )
                        )
                    );
                    const removedSemanticNodes = removedNodes.filter(
                        (node) =>
                            !node.data?.isSkillClone &&
                            !node.data?.isStateClone
                    );
                    const refreshSlots = removedSemanticNodes.some(
                        (node) =>
                            (node.data?.inSlots || []).some((slot) => slot?.path) ||
                            (node.data?.outSlots || []).some((slot) => slot?.path) ||
                            (node.data?.inheritedSlots || []).some((slot) => slot?.path)
                    );
                    void syncRemovedStates(
                        [...semanticRemovalIds],
                        {
                            refreshSlots,
                            referenceStateIds,
                            referenceSourceIds,
                        }
                    );
                    if (getDocumentSnapshot && checkSlotConnection) checkSlotConnection();
                }
                }
            }
            if (slotChanges.length > 0) {
                const removedSlotCloneIds = new Map();
                const removedPaths = new Set();
                slotChanges
                    .filter((change) => change.type === "remove")
                    .forEach((change) => {
                        const removedNode = live.slotNodes.find(
                            (node) => node.id === change.id
                        );
                        if (
                            removedNode?.data?.isSlotClone &&
                            removedNode.data?.cloneOfNodeId
                        ) {
                            removedSlotCloneIds.set(
                                removedNode.id,
                                removedNode.data.cloneOfNodeId
                            );
                        } else if (removedNode) {
                            removedPaths.add(getSlotPathFromNode(removedNode));
                        }
                    });

                if (removedSlotCloneIds.size > 0) {
                    setSlotEdges((currentEdges) =>
                        currentEdges.map((edge) => {
                            const canonicalSlotNodeId =
                                removedSlotCloneIds.get(edge.data?.slotNodeId ||
                                    (edge.data?.access === "read" ? edge.source : edge.target));
                            if (!canonicalSlotNodeId) return edge;

                            remappedSlotCloneEdgeIdsRef.current.add(edge.id);

                            return {
                                ...edge,
                                id: `${edge.id}-clone-remap-${crypto.randomUUID()}`,
                                ...(edge.data?.access === "read"
                                    ? { source: canonicalSlotNodeId }
                                    : { target: canonicalSlotNodeId }),
                                data: {
                                    ...(edge.data || {}),
                                    slotNodeId: canonicalSlotNodeId,
                                    canonicalSlotNodeId,
                                    controlPoints: [],
                                },
                            };
                        })
                    );
                }

                if (removedPaths.size > 0) {
                    setNodes((currentNodes) => currentNodes.map((node) => {
                        let data = node.data;
                        for (const key of ["inSlots", "outSlots"]) {
                            const slots = data?.[key];
                            if (!slots?.some((slot) => removedPaths.has(normalizeSlotPath(slot?.inherited?.xpath || slot?.path)))) continue;
                            data = { ...data, [key]: slots.map((slot) =>
                                removedPaths.has(normalizeSlotPath(slot?.inherited?.xpath || slot?.path))
                                    ? { ...slot, path: "", inherited: null } : slot) };
                        }
                        return data === node.data ? node : { ...node, data };
                    }));
                    setManualSlots?.((slots) => slots.filter((slot) =>
                        !removedPaths.has(normalizeSlotPath(slot?.inherited?.xpath || slot?.path))));
                    const removedVisualIds = new Set(live.slotNodes.filter((node) =>
                        removedPaths.has(getSlotPathFromNode(node))).map((node) => node.id));
                    setSlotEdges((currentEdges) => currentEdges.filter((edge) =>
                        !removedPaths.has(normalizeSlotPath(edge.data?.path)) &&
                        !removedVisualIds.has(edge.source) && !removedVisualIds.has(edge.target)));
                    (live.slotNodes || []).forEach((node) => {
                        if (node.data?.isSlotClone && removedPaths.has(getSlotPathFromNode(node)) &&
                            !slotChanges.some((change) => change.type === "remove" && change.id === node.id)) {
                            slotChanges.push({ id: node.id, type: "remove" });
                        }
                    });
                }
                onSlotNodesChange(slotChanges);
                if (removedPaths.size > 0) {
                    if (getDocumentSnapshot && checkSlotConnection) checkSlotConnection();
                    void Promise.resolve(syncSlotsAfterCommit?.()).catch((error) =>
                        console.warn("Could not synchronize slot deletion.", error));
                }
            }
        },
        [
            nodeById,
            slotNodeIdSet,
            onNodesChange,
            onSlotNodesChange,
            updateGraph,
            setNodes,
            setSlotEdges,
            syncRemovedStates,
            getDocumentSnapshot,
            setManualSlots,
            checkSlotConnection,
            syncSlotsAfterCommit,
        ]
    );

    const handleVisibleEdgesChange = useCallback(
        (changes) => {
            const ignoredRemapIds = remappedSlotCloneEdgeIdsRef.current;
            const live = getDocumentSnapshot?.() || { nodes: nodesRef.current, slotNodes: slotNodesRef.current, ...slotModelRef.current };
            const currentSlotEdges = live.slotEdges || [];
            const liveTransitionEdges = live.edges || edges;
            const liveNodes = live.nodes || nodesRef.current;
            const canonicalChanges = canonicalizeVisibleEdgeChanges(
                changes, liveTransitionEdges, liveNodes, currentSlotEdges
            );
            const effectiveChanges = canonicalChanges.filter((change) => {
                const shouldIgnore =
                    change.type === "remove" && (ignoredRemapIds.has(change.id) || protectedSlotEdgeIdsRef.current.has(change.id));
                if (shouldIgnore) {
                    ignoredRemapIds.delete(change.id);
                }
                if (shouldIgnore) return false;
                const edge = change.type === "remove" && currentSlotEdges.find((edge) => edge.id === change.id);
                if (change.type === "remove" && !edge && !liveTransitionEdges.some((edge) => edge.id === change.id)) return false;
                // Fixed child requirements are not writable child bindings.
                // Also guard the selected canonical slot if Flow reports its
                // connected edges before the rejected node-removal callback.
                if (edge && (edge.data?.subMachineInherited || live.slotNodes.some((node) =>
                    node.selected && (edge.source === node.id || edge.target === node.id) && isSlotDeletionProtected(node, live)))) return false;
                return true;
            });

            const slotEdgeIds = new Set(
                currentSlotEdges.map((edge) => edge.id)
            );

            const slotChanges = expandSharedSlotEdgeRemovals(
                liveNodes, currentSlotEdges,
                effectiveChanges.filter((change) => slotEdgeIds.has(change.id))
            );
            const transitionChanges = effectiveChanges.filter(
                (change) => !slotEdgeIds.has(change.id)
            );

            if (transitionChanges.length > 0) {
                const removesTransition = transitionChanges.some(
                    (change) => change.type === "remove"
                );

                if (removesTransition) {
                    const currentNodes = liveNodes;

                    // Removing the visible external part of a boundary
                    // transition must also remove its editor-only helper edge
                    // and Compound/Parallel border event. Otherwise stale
                    // exits such as Skill.* remain visible even though no
                    // semantic transition exists anymore.
                    const changedEdges = applyEdgeChanges(
                        transitionChanges,
                        liveTransitionEdges
                    );
                    const affectedTransitionSourceIds = new Set();

                    const getLogicalSourceEntries = (edge) => {
                        const storedEntries = Array.isArray(
                            edge?.data?.boundaryOriginalSources
                        )
                            ? edge.data.boundaryOriginalSources
                                  .map((entry) => ({
                                      sourceId: String(entry?.sourceId || ""),
                                      sourceHandle: String(
                                          entry?.sourceHandle || ""
                                      ),
                                  }))
                                  .filter(
                                      (entry) =>
                                          entry.sourceId && entry.sourceHandle
                                  )
                            : [];
                        if (storedEntries.length > 0) return storedEntries;

                        return [
                            {
                                sourceId:
                                    edge?.data?.boundaryOriginalSource ||
                                    edge?.data?.compoundOriginalSource ||
                                    edge?.data?.parallelOriginalSource ||
                                    edge?.source ||
                                    "",
                                sourceHandle: String(
                                    edge?.data?.boundaryOriginalSourceHandle ||
                                    edge?.data?.compoundOriginalSourceHandle ||
                                    edge?.data?.parallelOriginalSourceHandle ||
                                    edge?.sourceHandle ||
                                    edge?.label ||
                                    "success"
                                ),
                            },
                        ];
                    };

                    const isSemanticTransitionEdge = (edge) =>
                        !edge?.data?.boundaryInternalEdge &&
                        !edge?.data?.compoundInternalEdge &&
                        !edge?.data?.parallelInternalEdge &&
                        !String(edge?.id || "").startsWith(
                            "edge-internal-boundary-"
                        );

                    const removedTransientEventsByNode = new Map();
                    transitionChanges
                        .filter((change) => change.type === "remove")
                        .forEach((change) => {
                            const removedEdge = liveTransitionEdges.find(
                                (edge) => edge.id === change.id
                            );
                            if (!removedEdge) return;

                            getLogicalSourceEntries(removedEdge).forEach(
                                ({ sourceId, sourceHandle }) => {
                                    if (!sourceId || !sourceHandle) return;
                                    affectedTransitionSourceIds.add(sourceId);

                                    const sourceNode = currentNodes.find(
                                        (node) => node.id === sourceId
                                    );
                                    const matchingEvents = (
                                        sourceNode?.data?.events || []
                                    ).filter(
                                        (event) =>
                                            String(event?.id || "") ===
                                            sourceHandle
                                    );
                                    const isImportedOnlyHandle =
                                        matchingEvents.length > 0 &&
                                        matchingEvents.every(
                                            (event) =>
                                                event?.editorImportedSynthetic ||
                                                event?.editorBoundarySynthetic
                                        );

                                    if (sourceHandle === "*") return;

                                    if (
                                        !isWildcardTransitionEvent(sourceHandle) &&
                                        !isImportedOnlyHandle
                                    ) {
                                        return;
                                    }

                                    const stillUsed = changedEdges.some(
                                        (edge) =>
                                            isSemanticTransitionEdge(edge) &&
                                            getLogicalSourceEntries(edge).some(
                                                (entry) =>
                                                    entry.sourceId === sourceId &&
                                                    entry.sourceHandle ===
                                                        sourceHandle
                                            )
                                    );
                                    if (stillUsed) return;

                                    if (
                                        !removedTransientEventsByNode.has(
                                            sourceId
                                        )
                                    ) {
                                        removedTransientEventsByNode.set(
                                            sourceId,
                                            new Set()
                                        );
                                    }
                                    removedTransientEventsByNode
                                        .get(sourceId)
                                        .add(sourceHandle);
                                }
                            );
                        });

                    const transientCleanedNodes =
                        removedTransientEventsByNode.size === 0
                            ? currentNodes
                            : currentNodes.map((node) => {
                                const removedHandles =
                                    removedTransientEventsByNode.get(node.id);
                                if (!removedHandles) return node;
                                return {
                                    ...node,
                                    data: {
                                        ...node.data,
                                        events: (node.data?.events || []).filter(
                                            (event) =>
                                                !removedHandles.has(
                                                    String(event?.id || "")
                                                )
                                        ),
                                    },
                                };
                            });

                    // Clear the semantic event target/condition/assignments as
                    // well as the edge. Otherwise the exporter reconstructs the
                    // deleted transition from the stale source-node event.
                    const removedSemanticEdges = liveTransitionEdges.filter(edge =>
                        transitionChanges.some(change => change.type === "remove" && change.id === edge.id) &&
                        isSemanticTransitionEdge(edge));
                    const cleanedNodes = cleanEventsForDeletedTransitions(
                        transientCleanedNodes, removedSemanticEdges, changedEdges.filter(isSemanticTransitionEdge),
                        { getSourceId: getLogicalEdgeSourceId, getSourceHandle: getLogicalEdgeSourceHandle }
                    );

                    // Deletion must fully regenerate boundary edges and ports.
                    // Incremental updates are appropriate for addition/editing,
                    // but can retain fragments from a now-deleted transition.
                    const normalized = rebuildBoundaryTransitions(cleanedNodes, changedEdges);
                    updateGraph(() => ({ nodes: normalized.nodes, edges: normalized.edges }));
                    normalized.nodes.forEach((node, index) => {
                        if (node === currentNodes[index]) return;
                        requestAnimationFrame(() => updateNodeInternals(node.id));
                    });
                    void syncTransitionSources(
                        [...affectedTransitionSourceIds]
                    );
                } else {
                    onEdgesChange(transitionChanges);
                }
            }

            if (slotChanges.length === 0) {
                return;
            }

            const removedIds = new Set(
                slotChanges
                    .filter((change) => change.type === "remove")
                    .map((change) => change.id)
            );

            if (removedIds.size > 0) {
                const removedEdges = currentSlotEdges.filter((edge) =>
                    removedIds.has(edge.id)
                );

                // Keep both directional bindings and both visible edges in
                // the same document transaction. React Flow must never see
                // only half of a shared binding removed.
                updateGraph((graph) => ({
                    nodes: graph.nodes.map((node) => {
                        let nextNode = node;
                        removedEdges.forEach((edge) => {
                            if (edge.data?.subMachineInherited) return;
                            const access = edge.data?.access;
                            const skillNodeId = edge.data?.skillNodeId ||
                                (access === "read" ? edge.target : edge.source);
                            const slotIndex = Number(edge.data?.slotIndex);
                            if (skillNodeId !== node.id || !Number.isInteger(slotIndex) ||
                                !["read", "write"].includes(access)) return;
                            const field = access === "read" ? "inSlots" : "outSlots";
                            const selected = nextNode.data?.[field]?.[slotIndex];
                            if (!selected) return;
                            const partner = findSharedSlotPartner(nextNode.data, access, slotIndex);
                            const samePath = partner &&
                                normalizeSlotPath(selected.inherited?.xpath || selected.path) &&
                                normalizeSlotPath(selected.inherited?.xpath || selected.path) ===
                                    normalizeSlotPath(partner.slot.inherited?.xpath || partner.slot.path) &&
                                Boolean(selected.inherited) === Boolean(partner.slot.inherited) &&
                                String(selected.inherited?.state || "") ===
                                    String(partner.slot.inherited?.state || "");
                            const data = samePath
                                ? updateSharedSlotBinding(nextNode.data, access, slotIndex, { path: "", inherited: null })
                                : { ...nextNode.data, [field]: nextNode.data[field].map((slot, index) =>
                                    index === slotIndex ? { ...slot, path: "", inherited: null } : slot) };
                            nextNode = { ...nextNode, data };
                        });
                        return nextNode;
                    }),
                    slotEdges: applyEdgeChanges(slotChanges, graph.slotEdges),
                }));
            } else {
                onSlotEdgesChange(slotChanges);
            }

            if (removedIds.size > 0) {
                void Promise.resolve(syncSlotsAfterCommit?.()).catch((error) =>
                    console.warn("Could not synchronize slot disconnection.", error));
            }
        },
        [
            edges,
            onEdgesChange,
            onSlotEdgesChange,
            updateGraph,
            setNodes,
            updateNodeInternals,
            syncTransitionSources,
            getDocumentSnapshot,
            syncSlotsAfterCommit,
        ]
    );


    return {
        handleNodesChange,
        handleVisibleEdgesChange,
    };
}
