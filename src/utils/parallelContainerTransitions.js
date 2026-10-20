import { findContainerEventSources } from './parallelTransitionSources.js';
import { rebuildBoundaryTransitions } from './boundaryTransitions.js';
import { getTransitionTargetHandleForNode } from './editorGeometry.js';
import { isValidScxmlEventDescriptor } from './transitionEventValidation.js';

/**
 * Edit the ONE canonical SCXML transition per row. A new qualified descriptor
 * (Wait.success.*) is anchored on a matching skill and displayed in all lanes;
 * an unqualified descriptor (success.*) is an event on the Parallel itself.
 * Display helpers are regenerated, never stored as separate transitions.
 */
export function applyParallelContainerTransitions({ nodes, edges, parallelId, transitions, managedEdgeIds = [] }) {
    const owner = nodes.find(n => n.id === parallelId && n.type === 'parallel');
    if (!owner) throw new Error('Parallel not found');
    const byId = new Map(nodes.map(n => [n.id, n]));
    const managed = new Set(managedEdgeIds);
    const originalIds = new Set(edges.filter(e => !e.data?.boundaryInternalEdge &&
        !e.data?.compoundInternalEdge && !e.data?.parallelInternalEdge)
        .filter(e => e.data?.boundaryEventOwnerId === parallelId ||
            managed.has(e.id) || transitions.some(t => t.edgeId === e.id)).map(e => e.id));
    const kept = edges.filter(edge =>
        (edge.data?.boundaryInternalEdge || edge.data?.compoundInternalEdge ||
            edge.data?.parallelInternalEdge) ? false : !originalIds.has(edge.id));
    const actual = [];
    const used = new Set();
    for (const item of transitions) {
        const event = String(item.event || '').trim();
        if (!isValidScxmlEventDescriptor(event)) {
            throw new Error(`Invalid SCXML event descriptor: ${event}`);
        }
        const target = byId.get(item.target);
        if (!target || target.id === parallelId) throw new Error('A valid external target is required');
        let parentId = target.parentId;
        const visited = new Set();
        while (parentId && !visited.has(parentId)) {
            if (parentId === parallelId) throw new Error('A Parallel exit cannot target its own descendant');
            visited.add(parentId);
            parentId = byId.get(parentId)?.parentId;
        }
        const matches = findContainerEventSources({ owner, rawEvent: event, nodes });
        const previous = edges.find(e => e.id === item.edgeId);
        const priorPrimary = previous?.data?.boundaryOriginalSources?.[0]?.sourceId ||
            previous?.data?.boundaryOriginalSource || previous?.source;
        const source = matches.find(m => m.sourceId === priorPrimary) || matches[0] || {
            sourceId: parallelId, sourceHandle: event,
        };
        const id = previous?.id || `edge-${crypto.randomUUID()}`;
        if (used.has(id)) throw new Error('Duplicate transition identity');
        used.add(id);
        // An older routed edge carries source membership and port IDs from
        // its OLD descriptor. Never reuse that metadata when editing an event.
        const oldData = { ...(previous?.data || {}) };
        ["boundaryOriginalSources", "boundaryOriginalSource", "boundaryOriginalSourceHandle",
            "boundaryExitId", "compoundOriginalSource", "compoundOriginalSourceHandle",
            "compoundExitId", "parallelOriginalSource", "parallelOriginalSourceHandle",
            "parallelExitId", "boundaryKind"].forEach(key => delete oldData[key]);
        actual.push({
            ...(previous || {}),
            id,
            source: source.sourceId,
            sourceHandle: source.sourceHandle,
            target: target.id,
            targetHandle: getTransitionTargetHandleForNode(target),
            type: 'smartTransition',
            markerEnd: previous?.markerEnd || { type: 'arrowclosed' },
            label: source.sourceHandle,
            selected: false,
            data: {
                ...oldData,
                boundaryEventOwnerId: parallelId,
                boundaryImportedRawEvent: event,
                cond: item.cond || '',
                assignments: item.assignments || [],
                assign: item.assignments?.[0] || null,
            },
        });
    }
    const semantic = [...kept, ...actual];
    const normalized = rebuildBoundaryTransitions(nodes, semantic);
    // Ports for direct Parallel descriptors are derived in the shared router.
    // Do not store them independently here: deletion via a context menu must
    // remove them just as deletion via this panel does.
    return { nodes: normalized.nodes, edges: normalized.edges, affectedNodeIds: [...new Set([
        parallelId, ...actual.map(e => e.source),
        ...normalized.edges.filter(e => e.data?.parallelInternalEdge).map(e => e.target),
    ])] };
}
