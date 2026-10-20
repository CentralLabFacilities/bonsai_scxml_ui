import { createEditorNodeIndex } from './editorGraph.js';
import { getTransitionExitToken, transitionDescriptorCovers } from './transitionEvents.js';

const isSkill = (node) =>
    (node?.type === 'custom' || node?.type === 'submachine') &&
    !node.data?.isSkillClone && !node.data?.isStateClone;

const skillPrefixes = (node) => {
    const full = String(node?.data?.fullSkillName || '').trim();
    const bare = full.split('#')[0];
    const short = bare.split('.').filter(Boolean).pop();
    return [...new Set([full, bare, short, String(node?.data?.label || '').trim()]
        .filter(Boolean))].sort((a, b) => b.length - a.length);
};

const normalizedDescriptor = (descriptor, skillName) =>
    String(descriptor || '').trim().split(/\s+/).filter(Boolean)
        .map((token) => getTransitionExitToken(token, skillName)).join(' ');

/**
 * SCXML events propagate to enclosing states. A transition declared on a
 * Parallel catches matching skill events from *every* lane, except where a
 * closer unconditional handler takes precedence. These are visual sources of
 * ONE transition, not additional SCXML transitions.
 *
 * `handlersByNodeId` comes from parsed XML. For live graph edits we instead
 * use genuine container events (generated boundary port events are ignored).
 */
export function findContainerEventSources({
    owner, rawEvent, nodes, index = createEditorNodeIndex(nodes),
    handlersByNodeId = null,
}) {
    if (!owner || !['parallel', 'parallelLane', 'compound'].includes(owner.type)) return [];
    const descriptor = String(rawEvent || '').trim();
    if (!descriptor || descriptor.includes(' ')) return []; // Do not guess multi-descriptor ownership.

    const results = [];
    for (const node of nodes) {
        if (!isSkill(node) || !index.getAncestorIds(node).has(owner.id)) continue;
        const prefix = skillPrefixes(node).find((p) => descriptor.startsWith(`${p}.`));
        if (!prefix) continue;

        const handle = getTransitionExitToken(descriptor, prefix);
        // A direct, unconditional transition to a target still inside this
        // Parallel belongs to the skill (or a nearer compound), so it wins
        // over a handler declared on the Parallel. The editor stores the
        // target on real skill events, unlike display-only synthetic ports.
        if (!handlersByNodeId && (node.data?.events || []).some((event) => {
            if (event?.editorBoundarySynthetic || event?.editorImportedSynthetic && !event?.target ||
                String(event?.cond || '').trim() || !event?.target) return false;
            const actualTarget = index.byId.get(event.target);
            if (!actualTarget || !index.getAncestorIds(actualTarget).has(owner.id)) return false;
            return transitionDescriptorCovers(
                normalizedDescriptor(event.rawEvent || event.name || event.id, prefix),
                normalizedDescriptor(descriptor, prefix)
            );
        })) continue;
        // Parsed SCXML knows whether the skill itself declares a nearer
        // transition. Live editor skill events can also be projected exits,
        // so inspect only enclosing containers when using editor metadata.
        let parentId = handlersByNodeId ? node.id : node.parentId;
        const visited = new Set();
        let shadowed = false;
        while (parentId && parentId !== owner.id && !visited.has(parentId)) {
            visited.add(parentId);
            const parent = index.byId.get(parentId);
            if (!parent) break;
            const handlers = handlersByNodeId
                ? handlersByNodeId.get(parentId) || []
                : (parent.data?.events || []).filter((event) =>
                    event?.target && !event?.sourceNodeId && !event?.editorBoundarySynthetic
                ).map((event) => ({
                    eventId: event.rawEvent || event.name || event.id,
                    cond: event.cond,
                }));
            if (handlers.some((handler) =>
                !String(handler.cond || '').trim() && handler.eventId &&
                transitionDescriptorCovers(
                    normalizedDescriptor(handler.eventId, prefix),
                    normalizedDescriptor(descriptor, prefix)
                )
            )) {
                shadowed = true;
                break;
            }
            parentId = parent.parentId;
        }
        if (!shadowed) results.push({ sourceId: node.id, sourceHandle: handle });
    }
    return results;
}
