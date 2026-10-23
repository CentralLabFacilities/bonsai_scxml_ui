/** Keep editor identity separate from skill API data: a refresh must not remount the canvas. */
export function getRefreshableSkillNodeIds(nodes = []) {
    return nodes.filter((node) => node.type === 'custom' &&
        !node.data?.isSkillClone && !node.data?.isStateClone &&
        String(node.data?.fullSkillName || '').trim()
    ).map((node) => node.id);
}

/**
 * Update supplied exit descriptors without throwing away connected or explicitly
 * configured transitions when a running skill installation changes its API.
 * Unused API-removed events disappear; used events stay available for inspection
 * and SCXML round trips instead of silently losing their handle.
 */
export function reconcileRefreshedSkillEvents(previous = [], requested = [], linkedHandles = []) {
    const oldById = new Map(previous.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
    const used = new Set(linkedHandles);
    const result = [];
    const seen = new Set();
    const append = (id, description, retired = false) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const old = oldById.get(id);
        result.push({
            ...old,
            id,
            description: description ?? old?.description ?? '',
            selectedPackage: old?.selectedPackage || '',
            selectedSkill: old?.selectedSkill || '',
            target: old?.target ?? null,
            cond: old?.cond || '',
            assignments: old?.assignments || [],
            assignLocation: old?.assignLocation || '',
            assignExpr: old?.assignExpr || '',
            ...(retired ? { definitionMissing: true } : { definitionMissing: false }),
        });
    };
    requested.forEach((entry) => append(entry?.event, entry?.description || ''));
    append('fatal');
    append('*');
    previous.forEach((old) => {
        if (!old?.id || seen.has(old.id)) return;
        const hasSettings = Boolean(old.target || old.cond || old.assignLocation || old.assignExpr ||
            old.selectedPackage || old.selectedSkill || old.assignments?.length);
        if (used.has(old.id) || hasSettings || old.id.includes('*')) {
            append(old.id, old.description, true);
        }
    });
    return result;
}

/**
 * ReactFlow slot handles contain the array index, not just the key. Keep old
 * indices stable on an API refresh, or existing edges suddenly attach to a
 * different slot when a new request is inserted ahead of them.
 */
export function reconcileRefreshedSlotRequests(previous = [], requested = [], normalizeType = (type) => String(type || '').trim()) {
    const used = new Set();
    const configured = requested.map((slot, index) => ({ slot, index }));
    const matched = previous.map((old) => {
        const entry = configured.find(({ slot, index }) =>
            !used.has(index) && slot?.key === old?.key &&
            normalizeType(slot?.type) === normalizeType(old?.type));
        if (!entry) {
            // Retaining a removed declaration preserves its handle index and
            // existing SCXML binding until a user explicitly disconnects it.
            return { ...old, definitionMissing: true };
        }
        used.add(entry.index);
        return {
            ...entry.slot,
            key: entry.slot?.key || '',
            type: entry.slot?.type || 'Unknown',
            description: entry.slot?.description ?? old?.description ?? '',
            path: old?.path || '',
            inherited: old?.inherited || null,
            definitionMissing: false,
        };
    });
    configured.forEach(({ slot, index }) => {
        if (used.has(index)) return;
        matched.push({
            ...slot,
            key: slot?.key || '',
            type: slot?.type || 'Unknown',
            description: slot?.description || '',
            path: '',
            inherited: null,
            definitionMissing: false,
        });
    });
    return matched;
}
