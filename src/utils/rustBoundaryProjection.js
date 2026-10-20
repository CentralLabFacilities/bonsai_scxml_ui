import { rebuildBoundaryTransitions } from './boundaryTransitions.js';
import {
    applyRustWorkflowStatePatch,
    applyRustWorkflowTransitionPatch,
} from './rustWorkflowPatch.js';

/** Reconcile a Rust result as a single nodes+edges document transaction. */
export function reconcileRustBoundaryPatch(nodes, edges, patch, policy = {}) {
    const hasStatePatch = Boolean(
        (patch?.states?.length || 0) > 0 || (patch?.removedStateIds?.length || 0) > 0
    );
    const hasTransitionPatch = Boolean(
        (patch?.transitions?.length || 0) > 0 || (patch?.removedTransitionIds?.length || 0) > 0
    );
    const nextNodes = hasStatePatch
        ? applyRustWorkflowStatePatch(nodes, patch, { mode: policy.stateMode })
        : nodes;
    const nextEdges = hasTransitionPatch
        ? applyRustWorkflowTransitionPatch(edges, nextNodes, patch,
            { applyChanges: policy.applyTransitions })
        : edges;
    // The rebuild changes both the boundary handles on nodes and helper edges.
    return hasTransitionPatch
        ? rebuildBoundaryTransitions(nextNodes, nextEdges)
        : { nodes: nextNodes, edges: nextEdges };
}
