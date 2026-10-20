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

    const handleNodeClick = useCallback(
        (_, node) => {
            clearAllEdgeSelection();

            const isParallelLaneStructure =
                Boolean(node.data?.autoParallelLaneCompound) ||
                node.className === "compound-in-lane";

            if (isParallelLaneStructure) {
                let currentNode = node;
                const visited = new Set();

                while (
                    currentNode?.parentId &&
                    !visited.has(currentNode.id)
                ) {
                    visited.add(currentNode.id);
                    const parentNode = nodes.find(
                        (candidate) => candidate.id === currentNode.parentId
                    );

                    if (!parentNode) break;

                    if (parentNode.type === "parallel") {
                        setSelectedNodeId(parentNode.id);
                        setRightPanelTab("details");
                        setActiveTab("allgemein");
                        return;
                    }

                    currentNode = parentNode;
                }
            }

            setSelectedNodeId(node.id);
            setRightPanelTab("details");
        },
        [
            clearAllEdgeSelection,
            nodes,
            setActiveTab,
            setRightPanelTab,
            setSelectedNodeId,
        ]
    );

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
        handlePaneClick,
        handleNodeMouseEnter,
        handleNodeMouseLeave,
        handleEdgeMouseEnter,
        handleEdgeMouseLeave,
    };
}
