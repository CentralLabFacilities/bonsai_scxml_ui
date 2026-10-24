/**
 * Reconcile a transition-panel draft with edge removals made directly on the
 * canvas. Only previously observed canonical edge IDs may be removed:
 * unfinished transitions, and transitions not yet published, stay as drafts.
 */
export function reconcileExternallyRemovedTransitions(draft, committed, observedIds, currentIds) {
    const live = new Set(currentIds);
    const removed = new Set([...observedIds].filter(id => !live.has(id)));
    const keep = transition => !transition.edgeId || !removed.has(transition.edgeId);
    return {
        draft: draft.filter(keep),
        committed: committed.filter(keep),
        removed,
    };
}

/** Show scope priority only when more than one transition hierarchy level exists. */
export function hasTransitionScopeHierarchy(groups) {
    return groups.length > 1 || groups.some(group => group.depth > 0);
}
