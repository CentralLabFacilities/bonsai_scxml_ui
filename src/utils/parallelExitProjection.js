/**
 * React Flow-only projections of a single SCXML transition declared on a
 * parallel. A semantic edge has exactly one SCXML owner but may have many
 * visually active lane exit ports. Never pass these projections to document
 * state, history, transition sync or export.
 */
export function projectParallelLaneExitEdges(edges = [], nodeById = new Map()) {
    const helperAnchorsByExit = new Map();
    for (const edge of edges) {
        if (!edge?.data?.parallelInternalEdge || !edge?.data?.boundaryExitId) continue;
        const lane = nodeById.get(edge.target);
        const parallel = nodeById.get(lane?.parentId);
        if (lane?.type !== 'parallelLane' || parallel?.type !== 'parallel' ||
            parallel.data?.isCollapsed || lane.hidden) continue;
        const key = String(edge.data.boundaryExitId);
        if (!helperAnchorsByExit.has(key)) helperAnchorsByExit.set(key, new Set());
        helperAnchorsByExit.get(key).add(lane.id);
    }
    const projected = [];
    const identities = new Set(edges.map((edge) => `${edge.source}\u0000${edge.sourceHandle}\u0000${edge.target}\u0000${edge.data?.boundaryExitId || ''}`));
    for (const edge of edges) {
        if (!edge?.data?.parallelExitId || edge.data?.boundaryInternalEdge ||
            edge.data?.compoundInternalEdge || edge.data?.parallelInternalEdge ||
            edge.data?.editorVisualProjection) continue;
        const lanes = helperAnchorsByExit.get(String(edge.data.parallelExitId));
        if (!lanes || lanes.size < 2) continue;
        // Only a lane boundary can act as the visible parallel exit.
        if (nodeById.get(edge.source)?.type !== 'parallelLane') continue;
        for (const laneId of lanes) {
            if (laneId === edge.source) continue;
            const identity = `${laneId}\u0000${edge.sourceHandle}\u0000${edge.target}\u0000${edge.data.parallelExitId}`;
            if (identities.has(identity)) continue;
            identities.add(identity);
            projected.push({
                ...edge,
                id: `projection-${encodeURIComponent(edge.id)}-${encodeURIComponent(laneId)}`,
                source: laneId,
                sourceHandle: edge.sourceHandle,
                label: '',
                selected: false,
                // Interacting with this leg acts on its canonical SCXML edge.
                selectable: true,
                deletable: true,
                reconnectable: false,
                focusable: true,
                data: {
                    ...edge.data,
                    editorVisualProjection: true,
                    projectionOfEdgeId: edge.id,
                    // Do not show a second condition/assignment badge.
                    cond: '',
                    assignments: [],
                    assign: null,
                },
            });
        }
    }
    return projected;
}
