import { getTransitionScope } from "./transitionScopes.js";

/**
 * A new canonical edge may arrive while the transition editor is open.
 * Merge only newly observed graph edges; do not replace draft fields or
 * regenerate incomplete local transitions, which belong to the editor.
 */
export function appendPublishedGraphTransitions(draft, candidates, previousGraphIds, currentGraphIds) {
    const known = new Set(draft.map(item => String(item.edgeId || item.transitionId)));
    const additions = candidates.filter(item =>
        item.edgeId && currentGraphIds.has(item.edgeId) &&
        !previousGraphIds.has(item.edgeId) && !known.has(String(item.edgeId))
    );
    return additions.length ? [...draft, ...additions] : draft;
}

/**
 * Shared exit edges are a single SCXML transition owned by an enclosing
 * container. Their secondary skill sources are display-only: never feed them
 * to drawerCommit as individual transitions from the selected skill.
 */
export const getSharedContainerExitsForSkill = (sourceId, nodes, edges) => {
    const byId = new Map(nodes.map(node => [node.id, node]));
    return edges.flatMap(edge => {
        if (edge?.data?.boundaryInternalEdge || edge?.data?.compoundInternalEdge ||
            edge?.data?.parallelInternalEdge) return [];
        const sources = Array.isArray(edge?.data?.boundaryOriginalSources)
            ? edge.data.boundaryOriginalSources : [];
        if (sources.length < 2 || sources[0]?.sourceId === sourceId) return [];
        const matching = sources.find(entry => entry?.sourceId === sourceId);
        if (!matching) return [];
        const scope = getTransitionScope(sourceId, edge.target, nodes);
        if (!scope || !['compound', 'parallel'].includes(scope.nodeType)) return [];
        const target = byId.get(edge.target);
        return [{
            edgeId: edge.id,
            event: String(matching.sourceHandle || edge?.sourceHandle || "success"),
            target: edge.target,
            targetLabel: target?.data?.label || target?.data?.fullSkillName || edge.target,
            scopeLabel: scope.label,
            scopeType: scope.nodeType,
            cond: String(edge.data?.cond || ''),
        }];
    });
};

