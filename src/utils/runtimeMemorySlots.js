import { getExportFullSkillName } from "./editorScxml.js";
import { traceSlot } from "./slotReplayTrace.js";

const text = (value) => String(value ?? "").trim();
export const normalizeMemoryPath = (value) => {
    const path = text(value);
    return path ? `/${path.replace(/^\/+/, "")}` : "";
};

/** The mappings belong to the editor's semantic skill node, never to a slot
 * globally discovered via Memory WebSupport. inheritSlot's xpath wins. */
export function configuredSkillSlots(node) {
    if (!node || !["custom", "submachine"].includes(node.type)) return [];
    const entries = [
        ...(node.data?.inSlots || []).map((slot) => ({ ...slot, access: "read" })),
        ...(node.data?.outSlots || []).map((slot) => ({ ...slot, access: "write" })),
    ];
    const byKey = new Map();
    for (const entry of entries) {
        const path = normalizeMemoryPath(entry.inherited?.xpath || entry.inheritedMetadata?.xpath || entry.path);
        const key = text(entry.key || entry.name);
        if (!key && !path) continue;
        const id = `${path}\u0000${key}`;
        const existing = byKey.get(id);
        if (!existing) byKey.set(id, { path, key: key || path, type: text(entry.type), access: entry.access });
        else if (existing.access !== entry.access) existing.access = "read/write";
    }
    return [...byKey.values()];
}

/** The engine omits Java skill-package prefixes from runtime IDs, while
 * editor skill identities may keep them. Preserve every #instance suffix and
 * require a unique match; ambiguous short names must never be attributed to a
 * different skill (especially inside nested sub-state machines). */
export function runtimeSkillStateKey(value) {
    const state = text(value);
    const hash = state.indexOf("#");
    const name = hash < 0 ? state : state.slice(0, hash);
    return name.slice(name.lastIndexOf(".") + 1) + (hash < 0 ? "" : state.slice(hash));
}

export function skillForRuntimeState(tabs, state) {
    const candidates = (tabs || []).flatMap((tab) => (tab.nodes || [])
        .filter((node) => ["custom", "submachine"].includes(node.type) && !node.data?.isSkillClone && !node.data?.isStateClone)
        .map((node) => ({ tab, node })));
    const identities = (node) => [...new Set([
        getExportFullSkillName(node), node.data?.scxmlStateId, node.data?.fullSkillName,
    ].map(text).filter(Boolean))];
    const exact = candidates.filter(({ node }) => identities(node).includes(text(state)));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const key = runtimeSkillStateKey(state);
    if (!key) return null;
    const normalized = candidates.filter(({ node }) => identities(node).some((name) => runtimeSkillStateKey(name) === key));
    return normalized.length === 1 ? normalized[0] : null;
}

/** Return the latest *available* sampled value at or before a historical cursor.
 * HTTP captures finish independently and can therefore be appended out of order.
 * Use capture times rather than the insertion order of the async responses. */
export function latestSlotObservation(observations, path, beforeMs = Infinity) {
    const normalized = normalizeMemoryPath(path);
    let selected = null;
    let selectedAt = -Infinity;
    for (const entry of observations || []) {
        const at = entry.observedAtPerf ?? entry.observedAtMs;
        if (typeof at !== "number" || at > beforeMs || at < selectedAt) continue;
        // The skill-specific list is deliberately small. The separate cache
        // contains every path discovered by Memory WebSupport at this point,
        // without asserting that the skill read or wrote those other paths.
        const value = [...(entry.slots || []), ...(entry.cache || [])].find((item) =>
            normalizeMemoryPath(item.path) === normalized && item.status === "available");
        if (!value) continue;
        selectedAt = at;
        selected = { ...value, sourceState: entry.state, occurrence: entry.occurrence,
            captureKind: entry.kind || "skill-exit",
            observedAt: ["live-cache", "event-cache", "event-boundary"].includes(value.observationSource) && value.observedAt
                ? value.observedAt : entry.observedAt,
            observedAtMs: entry.observedAtMs };
    }
    return selected;
}

/** Read every configured path. getUsedSlots is advisory discovery metadata,
 * not a prerequisite for GET /getSlot: it can lag or fail independently.
 * An available GET value is authoritative even if the path was not listed. */
export async function readMappedSlotEntries(slots, usedRecords, readSlot) {
    const used = usedRecords == null ? null : new Map(usedRecords.map((item) => [normalizeMemoryPath(item.path), item.type]));
    return Promise.all((slots || []).map(async (slot) => {
        try {
            const value = await readSlot(slot.path);
            return { ...slot, ...value, type: value.type || slot.type || used?.get(slot.path) || "" };
        } catch {
            return { ...slot, type: slot.type || used?.get(slot.path) || "",
                status: used && !used.has(slot.path) ? "not-accessed" : "unavailable" };
        }
    }));
}

/** Capture only explicitly mapped entries as the skill's slot list, but keep a
 * separate path-keyed cache for the other slots already known to the Memory
 * backend or observed live. The graph/Run Assignments can inspect a slot across
 * skill boundaries without mistaking it for a write by that skill.
 *
 * This is a BACKGROUND cache; it creates no additional timeline snapshots.
 * An SSE value already observed at the snapshot boundary is authoritative for
 * that *observed point in time*. A later /getSlot response is only a fallback:
 * it must never overwrite an earlier historical value with a future value. */
export async function captureSlotEntries(mappedSlots, usedRecords, liveValues, readSlot, options = {}) {
    const mapped = [...new Map((mappedSlots || []).filter((slot) => normalizeMemoryPath(slot.path))
        .map((slot) => [normalizeMemoryPath(slot.path), { ...slot, path: normalizeMemoryPath(slot.path) }])).values()];
    const known = new Map(mapped.map((slot) => [slot.path, slot]));
    for (const item of usedRecords || []) {
        const path = normalizeMemoryPath(item.path);
        if (path && !known.has(path)) known.set(path, { path, key: path, type: item.type || "" });
    }
    for (const [rawPath, value] of Object.entries(liveValues || {})) {
        const path = normalizeMemoryPath(rawPath);
        if (path && !known.has(path)) known.set(path, { path, key: path, type: value?.type || "" });
    }
    const records = await readMappedSlotEntries([...known.values()], usedRecords, readSlot);
    const results = records.map((entry) => {
        const live = liveValues?.[entry.path];
        if (live?.status === "available") return { ...entry, ...live,
            path: entry.path, type: live.type || entry.type,
            observationSource: "event-cache", stale: Boolean(live.stale) };
        // A new SSE write while GET was pending means that GET may already
        // contain a value from after this snapshot's event. Discard it.
        if (options.changedAfterEvent?.(entry.path)) return { ...entry,
            status: "unavailable", value: undefined,
            observationSource: "changed-after-event" };
        if (entry.status === "available") return { ...entry,
            observationSource: "getSlot-after-event" };
        return entry;
    });
    const byPath = new Map(results.map((entry) => [entry.path, entry]));
    return {
        slots: mapped.map((slot) => ({ ...slot, ...(byPath.get(slot.path) || {}) })),
        cache: results,
    };
}

/** Freeze the values that the UI had ALREADY observed when a skill exits or a
 * transition is received. This is the only snapshot payload eligible for direct
 * historical frame lookup. GET requests started by that event may finish after
 * subsequent skills have written the same path, so their results must not be
 * installed retroactively into this frame. Missing data stays unobserved. */
export function freezeSlotEventBoundary(mappedSlots, liveValues, metadata) {
    const mapped = [...new Map((mappedSlots || [])
        .filter((slot) => normalizeMemoryPath(slot.path))
        .map((slot) => [normalizeMemoryPath(slot.path), { ...slot, path: normalizeMemoryPath(slot.path) }])).values()];
    const live = Object.fromEntries(Object.entries(liveValues || {})
        .map(([path, value]) => [normalizeMemoryPath(path), value])
        .filter(([path]) => path));
    const cache = Object.entries(live).map(([path, value]) => ({
        ...value, path, observationSource: "event-boundary",
    }));
    const slots = mapped.map((slot) => ({ ...slot, ...(live[slot.path] || {
        status: "not-observed",
    }), path: slot.path, observationSource: "event-boundary" }));
    return { ...metadata, slots, cache };
}

const writeInferenceCache = new WeakMap();

/** Associate Memory SSE writes with the most plausible completed skill,
 * using wall-clock proximity AND declared writable slots. SSE and SCXML do
 * not share a sequence, so this is an inference, not exact causal ordering.
 *
 * The matching is monotonic: when two slot writes are received together, the
 * first cannot be assigned to a *later* skill than the second. This is useful
 * when WebKit/Tauri delivers two already-completed SSE writes in one burst.
 * The values themselves remain immutable, unlike delayed GET observations. */
export function inferSlotWriteHistory(writes = [], skillExecutions = [], path) {
    const normalized = normalizeMemoryPath(path);
    let bySkill = writeInferenceCache.get(writes);
    if (!bySkill) { bySkill = new WeakMap(); writeInferenceCache.set(writes, bySkill); }
    let byPath = bySkill.get(skillExecutions);
    if (!byPath) { byPath = new Map(); bySkill.set(skillExecutions, byPath); }
    if (byPath.has(normalized)) return byPath.get(normalized);
    const events = writes.filter((write) => normalizeMemoryPath(write.path) === normalized)
        .map((write, index) => ({ ...write, localIndex: index }))
        .sort((a, b) => (a.order ?? a.localIndex) - (b.order ?? b.localIndex));
    const allCandidates = skillExecutions.filter((skill) => Number.isSafeInteger(skill.exitSequence) &&
        !["End", "Fatal"].includes(runtimeSkillStateKey(skill.state)))
        .slice().sort((a, b) => a.exitSequence - b.exitSequence);
    if (!events.length || !allCandidates.length) return [];

    // Give known writers priority over arbitrary neighbouring skill exits.
    // Memory SSE can deliver two writes within one millisecond, while the SCXML
    // stream reports many non-writing transitions in the same interval. A soft
    // timing cost across *all* skills would incorrectly attach the second write
    // to a Wait skill, causing it to disappear from the second writer snapshot.
    //
    // Skill instances of the same class can have different editor bindings:
    // SlotIO#1 may carry an output request with an empty path while SlotIO#2
    // carries no resolved request at all. Treat the latter as a possible writer
    // of that same path, unless its declared outputs explicitly exclude it.
    const outputsOf = (skill) => (skill.slots || []).filter((slot) =>
        String(slot.access || "").includes("write"));
    const familyOf = (skill) => text(skill.state).replace(/#.*$/, "");
    const directlyEligible = allCandidates.filter((skill) => outputsOf(skill).some((slot) => {
        const outputPath = normalizeMemoryPath(slot.path);
        return !outputPath || outputPath === normalized;
    }));
    const writerFamilies = new Set(directlyEligible.map(familyOf));
    const writerCandidates = allCandidates.filter((skill) => {
        if (!writerFamilies.has(familyOf(skill))) return false;
        const outputs = outputsOf(skill);
        return !outputs.length || outputs.some((slot) => {
            const outputPath = normalizeMemoryPath(slot.path);
            return !outputPath || outputPath === normalized;
        });
    });
    // Fall back to proximity only if there is no positive writer information.
    const candidates = writerCandidates.length ? writerCandidates : allCandidates;
    const declaredWriters = new Set(directlyEligible.map((skill) =>
        runtimeSkillStateKey(skill.state).replace(/#.*$/, "")));
    const cost = (event, skill) => {
        const output = (skill.slots || []).filter((slot) => String(slot.access || "").includes("write"));
        const exact = output.some((slot) => normalizeMemoryPath(slot.path) === normalized);
        const unbound = output.some((slot) => !normalizeMemoryPath(slot.path));
        const family = runtimeSkillStateKey(skill.state).replace(/#.*$/, "");
        const hintPenalty = exact ? 0 : unbound ? 0.7 : declaredWriters.has(family) ? 1.5
            : output.length ? 30 : 6;
        // The SSE timestamp is reception time; an SCXML event's timestamp is
        // generated in the same local JVM/host but may arrive by another route.
        // Keep a soft time score so declarations and write order can correct
        // short batches delivered together.
        const delta = Math.abs((event.observedAtMs ?? Date.parse(event.observedAt)) -
            (skill.endedAtMs ?? skill.receivedAtMs));
        return hintPenalty + (Number.isFinite(delta) ? Math.min(delta / 125, 80) : 15);
    };
    const assignments = [];
    if (events.length <= candidates.length && events.length <= 200 && candidates.length <= 2000) {
        // Minimum-cost ordered matching, with distinct writer executions.
        const back = [];
        let previous = candidates.map((skill) => cost(events[0], skill));
        back.push(candidates.map(() => -1));
        for (let i = 1; i < events.length; i += 1) {
            const next = Array(candidates.length).fill(Infinity);
            const links = Array(candidates.length).fill(-1);
            let best = Infinity;
            let bestIndex = -1;
            for (let j = 0; j < candidates.length; j += 1) {
                if (j > 0 && previous[j - 1] < best) {
                    best = previous[j - 1];
                    bestIndex = j - 1;
                }
                if (bestIndex >= 0) {
                    next[j] = best + cost(events[i], candidates[j]);
                    links[j] = bestIndex;
                }
            }
            previous = next;
            back.push(links);
        }
        let last = previous.indexOf(Math.min(...previous));
        for (let i = events.length - 1; i >= 0; i -= 1) {
            assignments[i] = candidates[last];
            last = back[i][last];
        }
    } else {
        // For unusually long runs, bounded-memory monotonic greedy matching.
        let position = 0;
        for (const event of events) {
            let best = position;
            for (let j = position; j < candidates.length; j += 1) {
                if (cost(event, candidates[j]) < cost(event, candidates[best])) best = j;
            }
            assignments.push(candidates[best]);
            position = best;
        }
    }
    const result = events.map((event, index) => ({ ...event,
        assignedSequence: assignments[index].exitSequence,
        sourceState: assignments[index].state,
        observationSource: "inferred-sse-write",
    }));
    byPath.set(normalized, result);
    traceSlot("write.attribution", {
        path: normalized,
        writerFamilies: [...writerFamilies],
        allCandidates: allCandidates.map((skill) => ({ state: skill.state,
            entrySequence: skill.entrySequence, exitSequence: skill.exitSequence,
            endedAtMs: skill.endedAtMs, outputs: outputsOf(skill).map((slot) => slot.path) })),
        preferredCandidates: candidates.map((skill) => skill.state + ":" + skill.exitSequence),
        assignments: result.map((item) => ({ value: item.value, order: item.order,
            receivedAtMs: item.observedAtMs, sourceState: item.sourceState,
            assignedSequence: item.assignedSequence })),
    });
    return result;
}

/** Skill snapshots display the value at the end of that skill's execution,
 * while transition snapshots display the value at their own event boundary. */
export function slotFrameBoundarySequence(frame, skillExecutions = []) {
    if (!frame) return -Infinity;
    if (frame.type === "state_entered") {
        const skill = skillExecutions.find((entry) => entry.entrySequence === frame.sequence &&
            entry.state === frame.state);
        return skill?.exitSequence ?? frame.sequence;
    }
    return frame.sequence ?? -Infinity;
}

/** A skill entry represents that execution's post-exit state; the linked
 * capture is frozen synchronously at its exit. Transitions are frozen at their
 * own event boundary. Never backfill a frame using a later HTTP sample. */
export function historicalSlotValue(observations, frame, path, writes = [], skillExecutions = []) {
    if (!frame) return null;
    if (writes.some((item) => normalizeMemoryPath(item.path) === normalizeMemoryPath(path))) {
        const inferred = inferSlotWriteHistory(writes, skillExecutions, path);
        const bound = slotFrameBoundarySequence(frame, skillExecutions);
        // Use write order + inferred skill completion. A later GET must never
        // override this ledger or turn a future value into an earlier one.
        const selected = [...inferred].reverse().find((item) => item.assignedSequence <= bound);
        return selected ? { ...selected, path: normalizeMemoryPath(path), status: "available",
            captureKind: "slot-write", inferred: true } : null;
    }
    const snapshot = observationForRuntimeFrame(observations, frame);
    const normalized = normalizeMemoryPath(path);
    const linked = snapshot?.slots?.find((entry) => normalizeMemoryPath(entry.path) === normalized);
    // When the state→skill mapping was not available at capture time, the
    // linked run-wide cache still contains the observed value. This does not
    // imply that this skill accessed the slot.
    const cached = snapshot?.cache?.find((entry) => normalizeMemoryPath(entry.path) === normalized);
    const linkedValue = linked?.status === "available" ? linked :
        cached?.status === "available" ? cached : linked || cached;
    if (linkedValue?.status === "available" || linkedValue?.status === "unavailable")
        return linkedValue?.status === "available" ? { ...linkedValue,
            observedAt: ["live-cache", "event-cache", "event-boundary"].includes(linkedValue.observationSource) && linkedValue.observedAt
                ? linkedValue.observedAt : snapshot.observedAt,
            sourceState: snapshot.state, occurrence: snapshot.occurrence, captureKind: snapshot.kind }
            : linkedValue;
    const preceding = latestSlotObservation(observations, path, frame.receivedAtPerf ?? frame.receivedAtMs ?? -Infinity);
    return preceding || linkedValue || null;
}

/** Snapshot linked to the selected skill occurrence or transition. HTTP values
 * were observed after exit/transition, so never label them as instantaneous. */
export function observationForRuntimeFrame(observations, frame) {
    if (!frame) return null;
    const items = observations || [];
    if (frame.type === "state_entered") {
        return [...items].reverse().find((item) => item.kind === "skill-exit" &&
            item.state === frame.state && item.entrySequence === frame.sequence) || null;
    }
    if (frame.type === "transition") {
        return [...items].reverse().find((item) => item.kind === "transition" && item.sequence === frame.sequence) || null;
    }
    return null;
}
