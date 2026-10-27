/**
 * The loaded runtime belongs to one semantic workflow document. Editor-only
 * position changes cannot change SCXML state identity, so they must not
 * invalidate its highlight and camera projection.
 *
 * Fingerprints come from getWorkflowDocumentFingerprint(), whose normalized
 * node records contain x/y and editorPositions for save/reload. Every other
 * field (including node IDs, parent IDs, parameters, transitions and slots)
 * remains part of the comparison. Do not relax the document-generation and
 * file-identity checks in useLiveExecution.
 */
export function sameRuntimeDocumentIgnoringPositions(loadedFingerprint, currentFingerprint) {
    if (typeof loadedFingerprint !== "string" || typeof currentFingerprint !== "string") return false;
    if (loadedFingerprint === currentFingerprint) return true;

    try {
        const loaded = JSON.parse(loadedFingerprint);
        const current = JSON.parse(currentFingerprint);
        if (!Array.isArray(loaded?.nodes) || !Array.isArray(current?.nodes)) return false;

        const withoutPositions = (document) => ({
            ...document,
            nodes: document.nodes.map((node) => {
                if (!node || typeof node !== "object" || Array.isArray(node)) return node;
                const { x, y, editorPositions, ...rest } = node;
                return {
                    ...rest,
                    editorPositions: Array.isArray(editorPositions)
                        ? editorPositions.map((position) => {
                            if (!position || typeof position !== "object" || Array.isArray(position)) return position;
                            const { x, y, ...identity } = position;
                            return identity;
                        })
                        : editorPositions,
                };
            }),
        });
        return JSON.stringify(withoutPositions(loaded)) === JSON.stringify(withoutPositions(current));
    } catch {
        // An unexpected fingerprint format must never crash React rendering
        // or accidentally enable following a different runtime document.
        return false;
    }
}
