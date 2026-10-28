/** Strip transition-specific data referencing removed states, retaining declared exit tokens. */
export function cleanEventsForDeletedStates(events, removedNodeIds) {
    return (events || []).flatMap((event) => {
        if (removedNodeIds.has(event?.sourceNodeId)) return [];
        if (!removedNodeIds.has(event?.target)) return [event];
        if (event.editorImportedSynthetic || event.editorBoundarySynthetic) return [];
        return [{
            ...event,
            target: null,
            cond: "",
            assignments: [],
            assign: null,
            assignLocation: "",
            assignExpr: "",
            selectedSkill: "",
            selectedPackage: "",
        }];
    });
}

/**
 * Removing a graph edge must also remove its persisted event target. The SCXML
 * exporter uses event targets as a recovery fallback when it sees an event
 * without a matching edge; leaving the old target resurrects deleted edges
 * (including their condition and assignments) in the next Rust sync.
 *
 * Keep declared exit-token handles, but clear only the removed transition's
 * metadata. Duplicate events to the same target are handled one at a time.
 */
export function cleanEventsForDeletedTransitions(nodes, removedEdges, remainingEdges, {
    getSourceId, getSourceHandle,
}) {
    const edits = new Map();
    const deletedIds = new Set(removedEdges.map(edge => String(edge?.id || '')));
    const signatures = (edge) => [String(getSourceId(edge) || ''), String(getSourceHandle(edge) || ''),
        String(edge?.target || ''), String(edge?.data?.cond || '')];
    const sameSignature = (edge, sourceId, event) => {
        const [source, handle, target, cond] = signatures(edge);
        return source === sourceId && handle === String(event.id || '') &&
            target === String(event.target || '') && cond === String(event.cond || '');
    };
    for (const edge of removedEdges) {
        if (!edge || !deletedIds.has(String(edge.id || ''))) continue;
        const sourceId = String(getSourceId(edge) || '');
        const events = edits.get(sourceId) || nodes.find(node => String(node.id) === sourceId)?.data?.events;
        if (!Array.isArray(events)) continue;
        const next = [...events];
        const handle = String(getSourceHandle(edge) || '');
        const target = String(edge.target || '');
        const cond = String(edge.data?.cond || '');
        const exactMatches = next.map((event, index) => ({ event, index })).filter(({ event }) =>
            event && String(event.id || '') === handle && String(event.target || '') === target &&
            String(event.cond || '') === cond);
        const matches = exactMatches.length ? exactMatches : next.map((event, index) => ({ event, index })).filter(({ event }) =>
            event && String(event.id || '') === handle && String(event.target || '') === target);
        const retained = remainingEdges.filter(other => sameSignature(other, sourceId,
            { id: handle, target, cond }));
        // A node may expose a single event entry shared by multiple stored
        // edges. Do not clear its target if another identical edge still uses it.
        if (matches.length <= retained.length) continue;
        const selected = matches[matches.length - 1];
        if (!selected) continue;
        next.splice(selected.index, 1,
            ...(selected.event.editorImportedSynthetic || selected.event.editorBoundarySynthetic
                ? []
                : [{
                    ...selected.event,
                    target: null,
                    cond: '',
                    assignments: [],
                    assign: null,
                    assignLocation: '',
                    assignExpr: '',
                    selectedSkill: '',
                    selectedPackage: '',
                }]));
        edits.set(sourceId, next);
    }
    if (!edits.size && !deletedIds.size) return nodes;
    return nodes.map(node => {
        const events = edits.get(String(node.id));
        const order = node.data?.containerTransitionOrder;
        const filteredOrder = Array.isArray(order) ? order.filter(id => !deletedIds.has(String(id))) : null;
        if (!events && (!filteredOrder || filteredOrder.length === order.length)) return node;
        return { ...node, data: { ...node.data,
            ...(events ? { events } : {}),
            ...(filteredOrder && filteredOrder.length !== order.length ? { containerTransitionOrder: filteredOrder } : {}),
        } };
    });
}
