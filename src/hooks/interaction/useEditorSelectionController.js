import { resolveCanonicalTransitionEdge } from "../../utils/transitionVisualOwnership.js";
import { useCallback } from "react";
import { isSlotEdge } from "../../utils/editorGraph";

export function useEditorSelectionController({
    nodes,
    edges,
    clearAllEdgeSelection,
    selectSlotEdge,
    selectTransitionEdge,
    onTransitionEdgeDoubleClick,
    setSelectedNodeId,
    setRightPanelTab,
    setActiveTab,
    setHoveredEditorNodeId,
    setHoveredEditorEdgeId,
}) {
    const handleEdgeClick = useCallback(
        (event, edge) => {
            if (
                edge.data?.compoundInitialEdge ||
                edge.data?.parallelEntryEdge
            ) {
                return;
            }

            if (isSlotEdge(edge)) {
                selectSlotEdge(edge.id);
                return;
            }

            const canonical = resolveCanonicalTransitionEdge(edge, edges, nodes);
            if (!canonical) return;
            selectTransitionEdge(
                canonical.id,
                Boolean(event.ctrlKey || event.metaKey)
            );
        },
        [selectSlotEdge, selectTransitionEdge, edges, nodes]
    );

    const handleEdgeDoubleClick = useCallback(
        (event, edge) => {
            if (
                edge.data?.compoundInitialEdge ||
                edge.data?.parallelEntryEdge
            ) {
                return;
            }

            if (isSlotEdge(edge)) {
                selectSlotEdge(edge.id);
                return;
            }

            const canonical = resolveCanonicalTransitionEdge(edge, edges, nodes);
            if (canonical) onTransitionEdgeDoubleClick(event, canonical);
        },
        [onTransitionEdgeDoubleClick, selectSlotEdge, edges, nodes]
    );

    // Keep graph selection separate from opening the Details inspector. A
    // single click should only focus a node; double-click is the explicit
    // request to inspect it. Resolve editor-generated lane structures to their
    // semantic Parallel so neither interaction exposes an internal wrapper.
    const getInspectableNode = useCallback((node) => {
        const isParallelLaneStructure =
            Boolean(node.data?.autoParallelLaneCompound) ||
            node.className === "compound-in-lane";
        if (!isParallelLaneStructure) return node;

        let currentNode = node;
        const visited = new Set();
        while (currentNode?.parentId && !visited.has(currentNode.id)) {
            visited.add(currentNode.id);
            const parent = nodes.find((candidate) => candidate.id === currentNode.parentId);
            if (!parent) break;
            if (parent.type === "parallel") return parent;
            currentNode = parent;
        }
        return node;
    }, [nodes]);

    const handleNodeClick = useCallback((_, node) => {
        clearAllEdgeSelection();
        setSelectedNodeId(getInspectableNode(node).id);
        // Selection must not change the inspector's current tab. In particular,
        // an open Skill Detail stays open when single-clicking another skill;
        // double-click remains the explicit way to open Details from other tabs.
    }, [clearAllEdgeSelection, getInspectableNode, setSelectedNodeId]);

    const handleNodeDoubleClick = useCallback((_, node) => {
        clearAllEdgeSelection();
        const inspectable = getInspectableNode(node);
        setSelectedNodeId(inspectable.id);
        // A double-click is an explicit request to open the node overview,
        // even when its Details panel currently shows Parameters or Slots.
        setActiveTab("allgemein");
        setRightPanelTab("details");
    }, [clearAllEdgeSelection, getInspectableNode, setActiveTab, setRightPanelTab, setSelectedNodeId]);

    const handlePaneClick = useCallback(() => {
        clearAllEdgeSelection();
        setSelectedNodeId(null);
        setRightPanelTab("datamodel");
    }, [clearAllEdgeSelection, setRightPanelTab, setSelectedNodeId]);

    const handleNodeMouseEnter = useCallback(
        (_, node) => {
            setHoveredEditorEdgeId(null);
            setHoveredEditorNodeId(node.id);
        },
        [setHoveredEditorEdgeId, setHoveredEditorNodeId]
    );

    const handleNodeMouseLeave = useCallback(
        (_, node) => {
            setHoveredEditorNodeId((current) =>
                current === node.id ? null : current
            );
        },
        [setHoveredEditorNodeId]
    );

    const handleEdgeMouseEnter = useCallback(
        (_, edge) => {
            setHoveredEditorNodeId(null);
            setHoveredEditorEdgeId(edge.id);
        },
        [setHoveredEditorEdgeId, setHoveredEditorNodeId]
    );

    const handleEdgeMouseLeave = useCallback(
        (_, edge) => {
            setHoveredEditorEdgeId((current) =>
                current === edge.id ? null : current
            );
        },
        [setHoveredEditorEdgeId]
    );

    return {
        handleEdgeClick,
        handleEdgeDoubleClick,
        handleNodeClick,
        handleNodeDoubleClick,
        handlePaneClick,
        handleNodeMouseEnter,
        handleNodeMouseLeave,
        handleEdgeMouseEnter,
        handleEdgeMouseLeave,
    };
}
