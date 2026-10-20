import { getLogicalEdgeSourceId, getLogicalEdgeSourceHandle } from "./transitionSemantics.js";
import { getTransitionExitToken, transitionDescriptorCovers } from "./transitionEvents.js";
import { boundaryTransitionKeys } from "./transitionBoundaryHighlight.js";

/** Match a runtime transition to the actual drawn path. Try explicit tokens
 * before wildcard fallbacks and never highlight a path to a different target.
 */
export function findRuntimeTransitionEdgeIds(edges, sourceIds, targetIds, transition) {
    const source = new Set(sourceIds);
    const target = new Set(targetIds);
    const eventToken = getTransitionExitToken(transition.event, transition.source);
    const candidate = (edges || []).filter((edge) => {
        const stored = edge.data?.boundaryOriginalSources || [];
        const validSource = source.has(getLogicalEdgeSourceId(edge)) || stored.some((entry) =>
            source.has(entry.sourceId || entry.nodeId || entry.id));
        if (!validSource) return false;
        const endpoint = edge.data?.boundaryOriginalTarget || edge.data?.compoundOriginalTarget ||
            edge.data?.parallelOriginalTarget || edge.target;
        return target.has(endpoint) || target.has(edge.target);
    });
    const token = (edge) => getTransitionExitToken(getLogicalEdgeSourceHandle(edge), transition.source);
    const exact = candidate.filter((edge) => {
        const handle = String(getLogicalEdgeSourceHandle(edge));
        return token(edge) === eventToken || handle === eventToken ||
            handle.endsWith(`-${eventToken}`);
    });
    const chosen = exact.length ? exact : candidate.filter((edge) =>
        transitionDescriptorCovers(token(edge), eventToken));
    const keys = new Set(chosen.flatMap(boundaryTransitionKeys));
    const ids = new Set(chosen.map((edge) => edge.id));
    // Every helper segment belonging to this logical exit follows its parent.
    for (const edge of edges || []) {
        if (boundaryTransitionKeys(edge).some((key) => keys.has(key))) ids.add(edge.id);
    }
    return ids;
}
