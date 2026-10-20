/**
 * Semantic SCXML transitions and React Flow's boundary fragments are different
 * objects. Resolve an interaction on any visible fragment to the ONE stored
 * transition that owns it. A helper shared by multiple transitions has no
 * unambiguous owner and must not silently delete all of them.
 */
export const isBoundaryTransitionFragment = (edge) => Boolean(
    edge?.data?.boundaryInternalEdge ||
    edge?.data?.compoundInternalEdge ||
    edge?.data?.parallelInternalEdge ||
    String(edge?.id || '').startsWith('edge-internal-boundary-')
);

export function resolveCanonicalTransitionEdge(visualEdgeOrId, edges = [], nodes = []) {
    const requestedId = typeof visualEdgeOrId === 'string'
        ? visualEdgeOrId : String(visualEdgeOrId?.id || '');
    if (!requestedId) return null;

    const stored = edges.find((edge) => edge.id === requestedId);
    const visual = typeof visualEdgeOrId === 'string' ? stored : visualEdgeOrId;
    const semantic = edges.filter((edge) =>
        !isBoundaryTransitionFragment(edge) &&
        !edge?.data?.compoundInitialEdge && !edge?.data?.parallelEntryEdge &&
        !edge?.data?.editorVisualProjection
    );

    if (visual?.data?.editorVisualProjection) {
        return semantic.find((edge) => edge.id === visual.data.projectionOfEdgeId) || null;
    }
    if (stored && !isBoundaryTransitionFragment(stored)) {
        return semantic.find((edge) => edge.id === stored.id) || null;
    }

    // React Flow's onEdgesChange supplies IDs, not the projected edge object.
    // Match the full stable projection ID, including an actual lane ID, rather
    // than parsing hyphens from user/skill IDs.
    if (!stored && requestedId.startsWith('projection-')) {
        const lanes = nodes.filter((node) => node.type === 'parallelLane');
        const matches = semantic.filter((edge) => edge.data?.parallelExitId &&
            lanes.some((lane) =>
                requestedId === `projection-${encodeURIComponent(edge.id)}-${encodeURIComponent(lane.id)}`
            )
        );
        return matches.length === 1 ? matches[0] : null;
    }
    if (!visual || !isBoundaryTransitionFragment(visual)) return null;
    const exitId = visual.data?.boundaryExitId ||
        visual.data?.compoundExitId || visual.data?.parallelExitId;
    if (!exitId) return null;
    const matches = semantic.filter((edge) =>
        [edge.data?.boundaryExitId, edge.data?.compoundExitId, edge.data?.parallelExitId]
            .some((id) => id && String(id) === String(exitId))
    );
    return matches.length === 1 ? matches[0] : null;
}

/** Map React Flow's visual edge mutations to changes on stored SCXML edges. */
export function canonicalizeVisibleEdgeChanges(
    changes = [], semanticEdges = [], nodes = [], slotEdges = []
) {
    const slotIds = new Set(slotEdges.map((edge) => edge.id));
    const storedById = new Map(semanticEdges.map((edge) => [edge.id, edge]));
    const seen = new Set();
    const canonicalChanges = [];
    for (const change of changes) {
        let next = change;
        if (change.type === 'remove' && !slotIds.has(change.id)) {
            const canonical = resolveCanonicalTransitionEdge(change.id, semanticEdges, nodes);
            if (!canonical) continue;
            // Node deletion also causes React Flow to emit removals for its
            // connected visual fragments. Only an explicitly selected owner
            // means the user intended to delete the shared transition itself.
            if (change.id !== canonical.id && !canonical.selected) continue;
            next = { ...change, id: canonical.id };
        } else if (change.type !== 'remove' && (
            String(change.id).startsWith('projection-') ||
            isBoundaryTransitionFragment(storedById.get(change.id))
        )) {
            // Canvas click handlers select the canonical transition instead.
            continue;
        }
        const key = `${next.type}:${next.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        canonicalChanges.push(next);
    }
    return canonicalChanges;
}
