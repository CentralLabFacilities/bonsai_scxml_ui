import { isEditorCloneNode } from "./editorClones.js";

// An SCXML initial selection is scoped to siblings, not the entire document.
// Library payloads are not trusted to decide which existing initial to replace:
// they may have been created before another asynchronous drop was committed.
const SEMANTIC_STATE_TYPES = new Set(["custom", "submachine", "compound", "parallel"]);
const INITIAL_CHILD_OWNERS = new Set(["compound", "parallelLane"]);

export function appendLibraryNodeWithInitial(currentNodes, incomingNode) {
    const parentId = incomingNode.parentId || null;
    const siblings = currentNodes.filter((node) =>
        (node.parentId || null) === parentId &&
        SEMANTIC_STATE_TYPES.has(node.type) &&
        !isEditorCloneNode(node)
    );
    if (!SEMANTIC_STATE_TYPES.has(incomingNode.type) || isEditorCloneNode(incomingNode)) {
        return [...currentNodes, incomingNode];
    }

    const parent = parentId ? currentNodes.find((node) => node.id === parentId) : null;
    // Preserve a valid explicit choice. Repair legacy duplicate flags at the
    // same scope, and prefer an existing sibling over the incoming library node.
    const preferredId = siblings.some((node) => node.id === parent?.data?.initialChildId)
        ? parent.data.initialChildId
        : (siblings.find((node) => node.data?.isInitial) || siblings[0])?.id || incomingNode.id;

    const normalized = currentNodes.map((node) => {
        if (node.id === parentId && INITIAL_CHILD_OWNERS.has(node.type) &&
            node.data?.initialChildId !== preferredId) {
            return { ...node, data: { ...node.data, initialChildId: preferredId } };
        }
        if ((node.parentId || null) !== parentId ||
            !SEMANTIC_STATE_TYPES.has(node.type) || isEditorCloneNode(node) ||
            Boolean(node.data?.isInitial) === (node.id === preferredId)) return node;
        return { ...node, data: { ...node.data, isInitial: node.id === preferredId } };
    });
    return [...normalized, {
        ...incomingNode,
        data: { ...incomingNode.data, isInitial: incomingNode.id === preferredId },
    }];
}
