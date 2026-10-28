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


// During a gesture, let the canvas own position-only changes. In particular,
// don't publish them into the semantic document (and invalidate all graph
// projections) until the drag finishes. Other changes retain their order.
export const splitDragPreviewChanges = (changes, preview) => {
    const moving = [];
    const other = [];
    for (const change of changes) {
        if (preview && change.type === 'position' &&
            (change.dragging === true || preview.has(change.id))) {
            moving.push(change);
        } else {
            other.push(change);
        }
    }
    return { moving, other };
};

export const withDragPreviewPositions = (nodes, preview) => {
    if (!preview?.size) return nodes;
    return nodes.map((node) => {
        const position = preview.get(node.id)?.position;
        if (!position || (node.position?.x === position.x && node.position?.y === position.y)) {
            return node;
        }
        return { ...node, position };
    });
};

export const finishedDragPositions = (preview, draggedNodes = []) => {
    const finalChanges = new Map(preview || []);
    for (const node of draggedNodes) {
        if (!node?.id || !node.position) continue;
        finalChanges.set(node.id, { id: node.id, type: 'position', position: node.position });
    }
    return [...finalChanges.values()]
        .filter((change) => Boolean(change.position))
        .map((change) => ({ ...change, dragging: false }));
};

// React Flow emits intermediate container dimensions on every pointer move.
// Treat these like drag positions: only in-flight geometry can be batched.
// Final dimensions (resizing:false), selections and structural edits flush first.
export const isLiveGeometryBatch = (changes = []) =>
    changes.length > 0 && changes.every((change) =>
        (change.type === 'position' && change.dragging === true) ||
        (change.type === 'dimensions' && change.resizing === true && Boolean(change.dimensions))
    );

export const collectLiveGeometry = (pending, changes) => {
    for (const change of changes) pending.set(`${change.id}:${change.type}`, change);
};
