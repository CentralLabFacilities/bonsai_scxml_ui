import { isEditorCloneNode } from "./editorClones.js";

// An SCXML initial selection is scoped to siblings, not the entire document.
// Library payloads are not trusted to decide which existing initial to replace:
// they may have been created before another asynchronous drop was committed.
const SEMANTIC_STATE_TYPES = new Set(["custom", "submachine", "compound", "parallel"]);
const INITIAL_CHILD_OWNERS = new Set(["compound", "parallelLane"]);

/** Reserve the first unused SCXML skill id against the current document. */
export function availableLibrarySkillName(nodes, requestedName) {
    const base = String(requestedName || "").replace(/#\d+$/, "");
    const used = new Set((nodes || [])
        .filter((node) => node.type === "custom" && !isEditorCloneNode(node))
        .map((node) => String(node.data?.fullSkillName || "")));
    let index = 1;
    while (used.has(`${base}#${index}`)) index += 1;
    return `${base}#${index}`;
}

// Skill inspection can finish after another drop has committed. Names assigned
// before awaiting the API may therefore collide even if initials do not.
// Resolve the identity in the same synchronous document transaction as append.
const resolveIncomingSkillIdentity = (currentNodes, incomingNode) => {
    if (!incomingNode.data) return incomingNode;
    if (incomingNode.type === "submachine") {
        // Sub-state-machine references need unique *SCXML* ids, not merely
        // unique React Flow node ids. The source file remains shared.
        const requested = String(incomingNode.data.fullSkillName || incomingNode.data.label || "").trim();
        if (!requested) return incomingNode;
        const used = new Set(currentNodes
            .filter((node) => node.type !== "slot" && !isEditorCloneNode(node))
            .map((node) => String(node.data?.fullSkillName || node.data?.label || node.id || "").trim()));
        if (!used.has(requested)) return incomingNode;
        const base = requested.replace(/#\d+$/, "");
        let index = 2;
        while (used.has(`${base}#${index}`)) index += 1;
        const name = `${base}#${index}`;
        return { ...incomingNode, data: { ...incomingNode.data,
            label: name, fullSkillName: name } };
    }
    if (incomingNode.type !== "custom") return incomingNode;
    const data = incomingNode.data;
    const fullName = String(data.fullSkillName || "").trim();
    if (!fullName) return incomingNode;

    if (data.isFinal) {
        const sharedId = String(data.scxmlStateId || fullName);
        const usedInstances = new Set(currentNodes
            .filter((node) => node.type === "custom" && !isEditorCloneNode(node) &&
                String(node.data?.scxmlStateId || node.data?.fullSkillName || "") === sharedId)
            .map((node) => String(node.data?.editorInstanceId || "").trim()));
        const requested = String(data.editorInstanceId || "").trim();
        if (requested && !usedInstances.has(requested)) return incomingNode;
        let index = 1;
        while (usedInstances.has(String(index))) index += 1;
        return { ...incomingNode, data: { ...data, editorInstanceId: String(index) } };
    }

    const usedNames = new Set(currentNodes
        .filter((node) => node.type === "custom" && !isEditorCloneNode(node))
        .map((node) => String(node.data?.fullSkillName || "")));
    if (!usedNames.has(fullName)) return incomingNode;
    return { ...incomingNode, data: {
        ...data, fullSkillName: availableLibrarySkillName(currentNodes, fullName),
    } };
};

/** Reserve a unique SCXML state name when creating a child file as well. */
export const reserveSubmachineStateName = (nodes, incomingNode) =>
    resolveIncomingSkillIdentity(nodes, incomingNode);

export function appendLibraryNodeWithInitial(currentNodes, incomingNode) {
    const resolvedNode = resolveIncomingSkillIdentity(currentNodes, incomingNode);
    const parentId = resolvedNode.parentId || null;
    const siblings = currentNodes.filter((node) =>
        (node.parentId || null) === parentId &&
        SEMANTIC_STATE_TYPES.has(node.type) &&
        !isEditorCloneNode(node)
    );
    if (!SEMANTIC_STATE_TYPES.has(resolvedNode.type) || isEditorCloneNode(resolvedNode)) {
        return [...currentNodes, resolvedNode];
    }

    const parent = parentId ? currentNodes.find((node) => node.id === parentId) : null;
    // Preserve a valid explicit choice. Repair legacy duplicate flags at the
    // same scope, and prefer an existing sibling over the incoming library node.
    const preferredId = siblings.some((node) => node.id === parent?.data?.initialChildId)
        ? parent.data.initialChildId
        : (siblings.find((node) => node.data?.isInitial) || siblings[0])?.id || resolvedNode.id;

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
        ...resolvedNode,
        data: { ...resolvedNode.data, isInitial: resolvedNode.id === preferredId },
    }];
}


/**
 * A Rust insertion result is a *partial* state patch. If it marks the newly
 * inserted state as initial without also patching its siblings, blindly
 * merging that result would leave two initials in the same scope. Keep the
 * selection already visible in the editor; explicit Set Initial commands use
 * a different reconciliation policy and are never processed here.
 *
 * Treat a root, each compound and each parallel lane as separate scopes.
 */
export function preserveInitialsAfterInsertion(beforeNodes, patchedNodes, insertedIds = []) {
    const inserted = new Set((insertedIds || []).map(String));
    if (!inserted.size) return patchedNodes;

    const activeScopes = new Set();
    for (const node of patchedNodes) {
        if (inserted.has(String(node.id)) && SEMANTIC_STATE_TYPES.has(node.type) &&
            !isEditorCloneNode(node)) {
            activeScopes.add(node.parentId || null);
        }
    }
    if (!activeScopes.size) return patchedNodes;

    const previousById = new Map(beforeNodes.map((node) => [node.id, node]));
    const patchedById = new Map(patchedNodes.map((node) => [node.id, node]));
    const corrections = new Map();

    for (const parentId of activeScopes) {
        const siblings = patchedNodes.filter((node) =>
            (node.parentId || null) === parentId &&
            SEMANTIC_STATE_TYPES.has(node.type) && !isEditorCloneNode(node));
        if (!siblings.length) continue;

        const siblingIds = new Set(siblings.map((node) => node.id));
        const previousParent = previousById.get(parentId);
        const patchedParent = patchedById.get(parentId);
        const previousSiblings = beforeNodes.filter((node) =>
            siblingIds.has(node.id) && (node.parentId || null) === parentId &&
            SEMANTIC_STATE_TYPES.has(node.type) && !isEditorCloneNode(node));

        const chosen = (
            (siblingIds.has(previousParent?.data?.initialChildId)
                ? previousParent.data.initialChildId : null) ||
            previousSiblings.find((node) => node.data?.isInitial)?.id ||
            previousSiblings[0]?.id ||
            (siblingIds.has(patchedParent?.data?.initialChildId)
                ? patchedParent.data.initialChildId : null) ||
            siblings.find((node) => node.data?.isInitial)?.id ||
            siblings[0].id
        );

        for (const sibling of siblings) {
            const shouldBeInitial = sibling.id === chosen;
            if (Boolean(sibling.data?.isInitial) !== shouldBeInitial) {
                corrections.set(sibling.id, {
                    ...sibling,
                    data: { ...sibling.data, isInitial: shouldBeInitial },
                });
            }
        }
        if (INITIAL_CHILD_OWNERS.has(patchedParent?.type) &&
            patchedParent.data?.initialChildId !== chosen) {
            corrections.set(parentId, {
                ...patchedParent,
                data: { ...patchedParent.data, initialChildId: chosen },
            });
        }
    }

    return corrections.size
        ? patchedNodes.map((node) => corrections.get(node.id) || node)
        : patchedNodes;
}

/** Prevent duplicate React Flow ids at insertion time, not after Rust sync. */
export function ensureUniqueLibraryNodeId(nodes, incomingNode, newId) {
    const ids = new Set((nodes || []).map((node) => String(node.id)));
    if (!ids.has(String(incomingNode.id))) return incomingNode;
    let candidate;
    do { candidate = String(newId()); } while (ids.has(candidate));
    return { ...incomingNode, id: candidate };
}
