/**
 * The only safe changes to coalesce are in-flight positions. A final position,
 * selection, resize or deletion must be committed in arrival order.
 */
export const isMovingPositionBatch = (changes = []) =>
    changes.length > 0 && changes.every(
        (change) => change.type === 'position' && change.dragging === true
    );

// Keep the latest change for each node, including its dragging flags and
// positionAbsolute metadata. React Flow can drag more than one node at once.
export const collectDraggedPositions = (pending, changes) => {
    changes.forEach((change) => pending.set(change.id, change));
};
