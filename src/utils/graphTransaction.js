/**
 * Build an immutable document snapshot for edits spanning several graph
 * collections. The caller publishes this snapshot exactly once. Updaters are
 * evaluated synchronously against the latest document, never inside React's
 * deferred or replayable setState updater callback.
 */
export function applyGraphTransaction(currentDocument, updater) {
    const patch = typeof updater === "function"
        ? updater(currentDocument)
        : updater;
    if (!patch) return currentDocument;
    if (Object.keys(patch).every((field) =>
        Object.is(currentDocument[field], patch[field])
    )) return currentDocument;
    return { ...currentDocument, ...patch };
}
