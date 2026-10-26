import { useCallback, useEffect, useRef, useState } from "react";
import { isEditorShortcutBlocked } from "./useGlobalEditorShortcuts";

import {
    cloneClipboardValue,
    getPersistentGraphClipboard,
    hasClipboardContent,
    isTypingTarget,
    sanitizePersistentGraphClipboard,
    setPersistentGraphClipboard,
} from "../../utils/editorClipboard";
import {
    buildCopiedGraphPaste,
    buildPastedSlotAliases,
    getClipboardPasteTranslation,
} from "../../utils/editorClipboardPaste";

export const useEditorClipboard = ({
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
    syncPastedEditorSubgraphAfterCommit,
    syncStateEditorPositions,
}) => {
    const graphClipboardRef = useRef(null);
    const [hasGraphClipboard, setHasGraphClipboard] = useState(() =>
        hasClipboardContent(getPersistentGraphClipboard())
    );
    const graphSelectionRef = useRef(new Set());
    const flowContainerRef = useRef(null);
    const editorPointerPositionRef = useRef({
        inside: false,
        clientX: null,
        clientY: null,
    });
    const captureGraphSelectionRef = useRef(null);
    const requestGraphPasteRef = useRef(null);

    useEffect(() => {
        graphClipboardRef.current = sanitizePersistentGraphClipboard();
    }, []);

    const handleGraphSelectionChange = useCallback(
        ({ nodes: selectedFlowNodes = [] }) => {
            graphSelectionRef.current = new Set(
                selectedFlowNodes.map((node) => node.id)
            );
        },
        []
    );

    // selection contains the selected nodes plus transitions whose source and
    // target are both in that selection. Pasting remaps graph IDs and keeps
    // the relative layout of the copied group.
    useEffect(() => {
        const captureSelection = () => {
            // Merge React Flow's selection callback with the controlled node
            // flags. This makes a just-clicked slot copyable even if the
            // selection callback has not propagated yet.
            const selectedIds = new Set(graphSelectionRef.current);
            nodes.forEach((node) => {
                if (node.selected) selectedIds.add(node.id);
            });
            slotNodes.forEach((node) => {
                if (node.selected) selectedIds.add(node.id);
            });

            let nodesToCopy = nodes.filter(
                (node) =>
                    selectedIds.has(node.id) &&
                    node.type !== "parallelLane"
            );
            let slotNodesToCopy = slotNodes.filter((node) =>
                selectedIds.has(node.id)
            );

            // A normal click also records the focused node in selectedNodeId.
            // Use it as the final fallback so slot copying does not depend on
            // React Flow's selection-event ordering.
            if (
                selectedNodeId &&
                nodesToCopy.length + slotNodesToCopy.length <= 1
            ) {
                const focusedNode =
                    nodes.find(
                        (node) =>
                            node.id === selectedNodeId &&
                            node.type !== "parallelLane"
                    ) ||
                    slotNodes.find((node) => node.id === selectedNodeId);
                const focusedNodeIsSelected =
                    nodesToCopy.some((node) => node.id === selectedNodeId) ||
                    slotNodesToCopy.some(
                        (node) => node.id === selectedNodeId
                    );

                if (focusedNode && !focusedNodeIsSelected) {
                    if (focusedNode.type === "slot") {
                        nodesToCopy = [];
                        slotNodesToCopy = [focusedNode];
                    } else {
                        nodesToCopy = [focusedNode];
                        slotNodesToCopy = [];
                    }
                }
            }

            if (nodesToCopy.length === 0 && slotNodesToCopy.length === 0) {
                return false;
            }

            // Copying a container must copy its complete subtree, including
            // structural parallel lanes. Those lanes are not directly
            // selectable, but they are required to preserve the hierarchy
            // and relative positions of the states inside a parallel node.
            const copiedNodeIds = new Set(
                nodesToCopy.map((node) => node.id)
            );
            const childrenByParent = new Map();
            nodes.forEach((node) => {
                if (!node.parentId) return;
                if (!childrenByParent.has(node.parentId)) {
                    childrenByParent.set(node.parentId, []);
                }
                childrenByParent.get(node.parentId).push(node);
            });

            const descendantQueue = nodesToCopy
                .filter(
                    (node) =>
                        node.type === "compound" ||
                        node.type === "parallel" ||
                        node.type === "parallelLane"
                )
                .map((node) => node.id);

            while (descendantQueue.length > 0) {
                const parentId = descendantQueue.shift();
                (childrenByParent.get(parentId) || []).forEach((child) => {
                    if (copiedNodeIds.has(child.id)) return;
                    copiedNodeIds.add(child.id);
                    descendantQueue.push(child.id);
                });
            }

            // Re-read from the canonical node array to keep React Flow's
            // parent-before-child ordering and to include non-selectable
            // parallel lane nodes in the clipboard.
            nodesToCopy = nodes.filter((node) =>
                copiedNodeIds.has(node.id)
            );

            const copiedEdges = edges.filter(
                (edge) =>
                    copiedNodeIds.has(edge.source) &&
                    copiedNodeIds.has(edge.target)
            );

            const clipboard = {
                nodes: nodesToCopy.map((node) =>
                    cloneClipboardValue({
                        ...node,
                        selected: false,
                    })
                ),
                slotNodes: slotNodesToCopy.map((node) => {
                    const canonicalSlotNodeId =
                        node.data?.cloneOfNodeId || node.id;
                    const canonicalSlotNode =
                        slotNodes.find(
                            (candidate) =>
                                candidate.id === canonicalSlotNodeId &&
                                !candidate.data?.isSlotClone
                        ) || node;

                    return cloneClipboardValue({
                        ...node,
                        selected: false,
                        data: {
                            ...(node.data || {}),
                            clipboardCanonicalSlotNodeId:
                                canonicalSlotNode.id ||
                                canonicalSlotNodeId,
                            clipboardCanonicalSlotPath:
                                canonicalSlotNode.data?.path ||
                                node.data?.path ||
                                "",
                        },
                    });
                }),
                edges: copiedEdges.map((edge) =>
                    cloneClipboardValue({
                        ...edge,
                        selected: false,
                    })
                ),
            };

            graphClipboardRef.current = clipboard;
            setPersistentGraphClipboard(clipboard);
            setHasGraphClipboard(true);
            return true;
        };

        const resolvePasteTargetPosition = (explicitFlowPosition = null) => {
            if (
                Number.isFinite(explicitFlowPosition?.x) &&
                Number.isFinite(explicitFlowPosition?.y)
            ) {
                return explicitFlowPosition;
            }

            const pointer = editorPointerPositionRef.current;
            if (
                pointer?.inside &&
                Number.isFinite(pointer.clientX) &&
                Number.isFinite(pointer.clientY)
            ) {
                return screenToFlowPosition({
                    x: pointer.clientX,
                    y: pointer.clientY,
                });
            }

            const editorRect = flowContainerRef.current?.getBoundingClientRect();
            if (editorRect?.width > 0 && editorRect?.height > 0) {
                return screenToFlowPosition({
                    x: editorRect.left + editorRect.width / 2,
                    y: editorRect.top + editorRect.height / 2,
                });
            }

            return screenToFlowPosition({
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
            });
        };

        const pasteClipboard = (targetPosition = null) => {
            const clipboard =
                graphClipboardRef.current || getPersistentGraphClipboard();
            if (clipboard && graphClipboardRef.current !== clipboard) {
                graphClipboardRef.current = clipboard;
            }
            const copiedStateNodes = clipboard?.nodes || [];
            const copiedSlotNodes = clipboard?.slotNodes || [];
            const copiedNodeCount =
                copiedStateNodes.length + copiedSlotNodes.length;

            if (copiedNodeCount === 0) return false;

            const resolvedPasteTarget = resolvePasteTargetPosition(targetPosition);
            const pasteTranslation = getClipboardPasteTranslation(
                clipboard,
                resolvedPasteTarget
            );

            // Slot declarations are unique semantic SCXML objects. Copy/paste
            // therefore creates visual aliases for selected slots instead of a
            // second declaration with the same path.
            if (copiedStateNodes.length === 0 && copiedSlotNodes.length > 0) {
                const pastedSlotAliases = buildPastedSlotAliases({
                    copiedSlotNodes,
                    translation: pasteTranslation,
                    slotNodes,
                });
                if (pastedSlotAliases.length === 0) return false;

                const nextSlotNodes = [
                    ...slotNodes.map((node) => ({
                        ...node,
                        selected: false,
                    })),
                    ...pastedSlotAliases,
                ];

                setNodes((currentNodes) =>
                    currentNodes.map((node) => ({
                        ...node,
                        selected: false,
                    }))
                );
                setSlotNodes(nextSlotNodes);
                setEdges((currentEdges) =>
                    currentEdges.map((edge) => ({
                        ...edge,
                        selected: false,
                    }))
                );
                setSlotEdges((currentEdges) =>
                    currentEdges.map((edge) => ({
                        ...edge,
                        selected: false,
                    }))
                );

                const firstPastedSlot = pastedSlotAliases[0];
                setSelectedNodeId(firstPastedSlot.id);
                setRightPanelTab("details");
                setActiveTab("slots");

                requestAnimationFrame(() => {
                    pastedSlotAliases.forEach((node) =>
                        updateNodeInternals(node.id)
                    );
                });

                return true;
            }

            const {
                pastedIds,
                pastedSlotAliases,
                nextNodes,
                nextSlotNodes,
                nextEdges,
                firstPastedNode,
                pasteCommand,
            } = buildCopiedGraphPaste({
                clipboard,
                nodes,
                edges,
                slotNodes,
                pasteTranslation,
            });

            setNodes(nextNodes);
            setSlotNodes(nextSlotNodes);
            setEdges(nextEdges);

            setSelectedNodeId(firstPastedNode?.id || null);

            // Slot paths live on the skill nodes. Rebuild the slot-view edges
            // so copied skills immediately retain their slot connections too,
            // while preserving any visual slot aliases pasted with the group.
            requestAnimationFrame(() => {
                checkSlotConnection(nextNodes, null, nextSlotNodes);

                pastedIds.forEach((nodeId) => {
                    updateNodeInternals(nodeId);
                });
                pastedSlotAliases.forEach((node) => {
                    updateNodeInternals(node.id);
                });
            });
            if (pastedIds.size > 0) {
                void syncPastedEditorSubgraphAfterCommit?.(pasteCommand);

                // Visual references are not semantic states. Their positions
                // remain attached to the canonical source state in Rust.
                const referenceSourceIds = new Set(
                    nextNodes
                        .filter(
                            (node) =>
                                pastedIds.has(node.id) &&
                                (node.data?.isSkillClone || node.data?.isStateClone)
                        )
                        .map((node) => String(node.data?.cloneOfNodeId || "").trim())
                        .filter(Boolean)
                );
                referenceSourceIds.forEach((sourceId) => {
                    void syncStateEditorPositions?.(sourceId);
                });
            }

            return true;
        };

        // Clipboard pastes always produce an independent copy. References can
        // still be created explicitly through the node context menu.
        const requestPasteClipboard = (targetPosition = null) =>
            pasteClipboard(targetPosition);

        captureGraphSelectionRef.current = captureSelection;
        requestGraphPasteRef.current = requestPasteClipboard;

        const handleGraphClipboardShortcut = (event) => {
            if (event.defaultPrevented || isEditorShortcutBlocked(event)) return;
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            if (activeMode === "code" || isTypingTarget(event.target)) return;

            const key = String(event.key || "").toLowerCase();

            if (key === "a") {
                event.preventDefault();
                clearAllEdgeSelection();
                setSelectedNodeId(null);

                setNodes((currentNodes) =>
                    currentNodes.map((node) => ({
                        ...node,
                        selected: node.selectable !== false,
                    }))
                );

                if (activeMode === "slots" || activeMode === "overview") {
                    setSlotNodes((currentNodes) =>
                        currentNodes.map((node) => ({
                            ...node,
                            selected: node.selectable !== false,
                        }))
                    );
                }
                return;
            }

            if (key === "c") {
                if (captureSelection()) {
                    event.preventDefault();
                }
                return;
            }

            if (key === "v") {
                if (graphClipboardRef.current || getPersistentGraphClipboard()) {
                    event.preventDefault();
                    requestPasteClipboard();
                }
                return;
            }

            if (key === "d") {
                if (!captureSelection()) return;
                event.preventDefault();
                requestPasteClipboard();
            }
        };

        // Capture phase makes the graph clipboard deterministic even when
        // React Flow or a focused panel component handles the same shortcut.
        window.addEventListener(
            "keydown",
            handleGraphClipboardShortcut,
            true
        );
        return () => {
            if (captureGraphSelectionRef.current === captureSelection) {
                captureGraphSelectionRef.current = null;
            }
            if (requestGraphPasteRef.current === requestPasteClipboard) {
                requestGraphPasteRef.current = null;
            }
            window.removeEventListener(
                "keydown",
                handleGraphClipboardShortcut,
                true
            );
        };
    }, [
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
        syncPastedEditorSubgraphAfterCommit,
        syncStateEditorPositions,
    ]);

    return {
        hasGraphClipboard,
        flowContainerRef,
        editorPointerPositionRef,
        handleGraphSelectionChange,
        captureGraphSelection: () => captureGraphSelectionRef.current?.(),
        requestGraphPaste: (targetPosition = null) =>
            requestGraphPasteRef.current?.(targetPosition),
    };
};
