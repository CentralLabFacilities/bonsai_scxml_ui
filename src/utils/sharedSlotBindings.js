/**
 * One logical read/write request, two existing SCXML/React Flow directions.
 * Only unambiguous key + type pairs are combined: same-name requests with
 * different types or duplicate occurrences must remain independent.
 */
const slotIdentity = (slot) => {
    const key = String(slot?.key ?? "").trim();
    const type = String(slot?.type ?? "").trim().toLowerCase();
    return key && type && type !== "unknown" ? `${key}\u0000${type}` : "";
};

const inheritanceOf = (slot) => slot?.inheritedMetadata ?? slot?.inherited;
const effectivePath = (slot) => String(inheritanceOf(slot)?.xpath || slot?.path || "").trim().replace(/^\/+/, "");
const conflictingInheritance = (a, b) => {
    const aInherited = inheritanceOf(a);
    const bInherited = inheritanceOf(b);
    if (Boolean(aInherited) !== Boolean(bInherited)) return true;
    return Boolean(aInherited && bInherited && (
        String(aInherited.state || "").trim() !== String(bInherited.state || "").trim() ||
        effectivePath(a) !== effectivePath(b)
    ));
};

const slotsFor = (data, access) =>
    Array.isArray(data?.[access === "read" ? "inSlots" : "outSlots"])
        ? data[access === "read" ? "inSlots" : "outSlots"]
        : [];

export function findSharedSlotPartner(data, access, index) {
    if (access !== "read" && access !== "write") return null;
    const source = slotsFor(data, access);
    const identity = slotIdentity(source[index]);
    if (!identity || source.filter((slot) => slotIdentity(slot) === identity).length !== 1) return null;
    const opposite = access === "read" ? "write" : "read";
    const matches = slotsFor(data, opposite)
        .map((slot, slotIndex) => ({ slot, index: slotIndex }))
        .filter(({ slot }) => slotIdentity(slot) === identity);
    return matches.length === 1 ? { access: opposite, ...matches[0] } : null;
}

export function updateSharedSlotBinding(data, access, index, changes) {
    const field = access === "read" ? "inSlots" : access === "write" ? "outSlots" : null;
    if (!field || !slotsFor(data, access)[index]) return data;
    const partner = findSharedSlotPartner(data, access, index);
    const patch = (slot) => ({
        ...slot,
        ...changes,
        ...(Object.prototype.hasOwnProperty.call(changes, "path") &&
            !Object.prototype.hasOwnProperty.call(changes, "inherited") && slot.inherited
            ? { inherited: { ...slot.inherited, xpath: changes.path } }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(changes, "inherited")
            ? { inherited: changes.inherited ? { ...changes.inherited } : null }
            : {}),
    });
    const updated = {
        ...data,
        [field]: slotsFor(data, access).map((slot, i) => i === index ? patch(slot) : slot),
    };
    if (!partner) return updated;
    const partnerField = partner.access === "read" ? "inSlots" : "outSlots";
    updated[partnerField] = slotsFor(data, partner.access).map((slot, i) =>
        i === partner.index ? patch(slot) : slot);
    return updated;
}

// For UI only. Original slot-array offsets and handle IDs are never changed.
export function groupSharedSlotEntries(entries, allowPairing = true) {
    if (!allowPairing) return entries.map((entry) => ({
        ...entry, handles: [entry], groupKey: entry.handleId,
    }));
    const identity = (entry) => entry?.handleId?.startsWith("slot-skill-") ? slotIdentity(entry) : "";
    const grouped = [];
    const taken = new Set();
    for (const entry of entries) {
        if (taken.has(entry.handleId)) continue;
        const id = identity(entry);
        const opposite = entry.access === "read" ? "write" : "read";
        const same = id && entries.filter((candidate) => identity(candidate) === id && candidate.access === entry.access);
        const other = id && entries.filter((candidate) => identity(candidate) === id && candidate.access === opposite);
        const partner = same?.length === 1 && other?.length === 1 ? other[0] : null;
        const handles = partner ? [entry, partner] : [entry];
        handles.forEach((handle) => taken.add(handle.handleId));
        grouped.push({
            ...entry, handles, groupKey: handles.map((handle) => handle.handleId).sort().join("|"),
            access: partner ? "read-write" : entry.access,
            inherited: handles.some((handle) => handle.inherited),
            conflictingPaths: Boolean(partner && effectivePath(entry) && effectivePath(partner) &&
                effectivePath(entry) !== effectivePath(partner)),
            conflictingInheritance: Boolean(partner && effectivePath(entry) && effectivePath(partner) &&
                conflictingInheritance(entry, partner)),
        });
    }
    return grouped;
}

export function getGroupedSkillSlotRequests(data) {
    const entries = [
        ...slotsFor(data, "read").map((slot, index) => ({ ...slot, access: "read", index, handleId: `slot-skill-read-${index}` })),
        ...slotsFor(data, "write").map((slot, index) => ({ ...slot, access: "write", index, handleId: `slot-skill-write-${index}` })),
    ];
    return groupSharedSlotEntries(entries);
}

/** Disconnecting either direction removes both edges ONLY if they actually
 * refer to the same path. Never erase an older document's conflicting binding.
 */
export function expandSharedSlotEdgeRemovals(nodes, slotEdges, changes) {
    const byNode = new Map((nodes || []).map((node) => [node.id, node]));
    const edgesById = new Map((slotEdges || []).map((edge) => [edge.id, edge]));
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    const additions = [];
    for (const id of [...removed]) {
        const edge = edgesById.get(id);
        if (!edge || edge.data?.subMachineInherited) continue;
        const node = byNode.get(edge.data?.skillNodeId);
        const access = edge.data?.access;
        const index = Number(edge.data?.slotIndex);
        const partner = findSharedSlotPartner(node?.data, access, index);
        const current = slotsFor(node?.data, access)[index];
        if (!partner || !current || !effectivePath(current) || !effectivePath(partner.slot) ||
            conflictingInheritance(current, partner.slot) ||
            effectivePath(current) !== effectivePath(partner.slot)) continue;
        const counterpart = (slotEdges || []).find((candidate) =>
            candidate.data?.edgeKind === "slot" && !candidate.data?.subMachineInherited &&
            candidate.data?.skillNodeId === node.id && candidate.data?.access === partner.access &&
            Number(candidate.data?.slotIndex) === partner.index);
        if (counterpart && !removed.has(counterpart.id)) {
            additions.push({ id: counterpart.id, type: "remove" });
            removed.add(counterpart.id);
        }
    }
    return additions.length ? [...changes, ...additions] : changes;
}

/** API refresh may expose the missing direction after a binding already exists.
 * Copy ONLY into an unbound counterpart; never select between two old paths.
 */
export function fillMissingSharedSlotBindings(data) {
    let next = data;
    for (const row of getGroupedSkillSlotRequests(data)) {
        if (row.handles.length !== 2) continue;
        const [a, b] = row.handles;
        const source = effectivePath(a) && !effectivePath(b) ? a :
            effectivePath(b) && !effectivePath(a) ? b : null;
        if (!source) continue;
        const target = source === a ? b : a;
        next = updateSharedSlotBinding(next, target.access, target.index, {
            path: source.path || `/${effectivePath(source)}`,
            inherited: source.inherited || null,
        });
    }
    return next;
}
