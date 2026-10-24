/**
 * Drawing a second edge from one skill is an explicit new transition, even
 * when its event and target match an existing edge. A different skill inside
 * the same parallel may instead be showing an already shared SCXML handler.
 *
 * Source/handle extraction and hierarchy resolution are supplied by the
 * semantic graph layer. Never infer ownership from visual boundary handles.
 */
export function findExistingSharedParallelExit({
    edges, nodes, sourceId, sourceHandle, targetId, parallelId,
    logicalSourceIdOf, logicalSourceHandleOf, exitedParallelIdsOf,
}) {
    if (!parallelId) return null;
    const byId = new Map((nodes || []).map((node) => [node.id, node]));
    const descriptor = (node, handle) => {
        const skillName = String(node?.data?.fullSkillName || node?.data?.label || node?.id || '')
            .split('#')[0].split('.').pop();
        return `${skillName}.${handle}`;
    };
    const expected = descriptor(byId.get(sourceId), sourceHandle);
    return (edges || []).find((edge) => {
        if (edge.data?.boundaryInternalEdge || edge.data?.compoundInternalEdge ||
            edge.data?.parallelInternalEdge || edge.target !== targetId) return false;
        const existingSourceId = logicalSourceIdOf(edge);
        // Same originating skill: a new drawn edge must create a new transition.
        if (existingSourceId === sourceId) return false;
        const existingSource = byId.get(existingSourceId);
        if (!existingSource || descriptor(existingSource, logicalSourceHandleOf(edge)) !== expected) return false;
        return (exitedParallelIdsOf(existingSourceId, targetId) || []).includes(parallelId);
    }) || null;
}
