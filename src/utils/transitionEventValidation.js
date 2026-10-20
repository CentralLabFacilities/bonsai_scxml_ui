/**
 * Graph identities and boundary handle IDs may be used to *render* SCXML
 * transitions, but must never become SCXML event descriptors. Check every
 * segment because older export/analysis paths sometimes prefixed a skill name
 * (e.g. Wait.skill-node-UUID) to an internal handle.
 */
export const isEditorInternalEvent = (value) => String(value || '').trim()
    .split('.').some(segment =>
        /^(?:skill-node|parallel-lane|slot-node|edge)-[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(segment) ||
        /^(?:compound-entry|target-|edge-internal-boundary-|skill-node-)/.test(segment)
    );

/** One SCXML event descriptor; multi-descriptor transitions are not offered here. */
export const isValidScxmlEventDescriptor = (value) => {
    const event = String(value || '').trim();
    if (!event || isEditorInternalEvent(event) || /\s/.test(event)) return false;
    return event === '*' || /^(?:[A-Za-z_][\w:-]*)(?:\.(?:[A-Za-z_][\w:-]*|\*|\*\*))*$/.test(event);
};
