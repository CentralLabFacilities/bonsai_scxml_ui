/**
 * Reorder lane IDs, independently of their descendants or React Flow nodes.
 * SCXML semantics and existing state IDs are unchanged by an ordering gesture.
 * Returns the original array when the operation is invalid or a no-op.
 */
export function reorderParallelLaneIds(orderedIds, laneId, movement) {
    if (!Array.isArray(orderedIds) || !orderedIds.includes(laneId)) return orderedIds;
    const sourceIndex = orderedIds.indexOf(laneId);
    if (typeof movement === 'object' && movement?.targetLaneId) {
        const destinationIndex = orderedIds.indexOf(movement.targetLaneId);
        if (destinationIndex < 0 || destinationIndex === sourceIndex ||
            !['before', 'after'].includes(movement.placement)) return orderedIds;
        const next = [...orderedIds];
        next.splice(sourceIndex, 1);
        const destinationAfterRemoval = next.indexOf(movement.targetLaneId);
        next.splice(destinationAfterRemoval + (movement.placement === 'after' ? 1 : 0), 0, laneId);
        return next.every((id, index) => id === orderedIds[index]) ? orderedIds : next;
    }
    if (movement !== 'up' && movement !== 'down') return orderedIds;
    const destinationIndex = sourceIndex + (movement === 'up' ? -1 : 1);
    if (destinationIndex < 0 || destinationIndex >= orderedIds.length) return orderedIds;
    const next = [...orderedIds];
    [next[sourceIndex], next[destinationIndex]] = [next[destinationIndex], next[sourceIndex]];
    return next;
}
