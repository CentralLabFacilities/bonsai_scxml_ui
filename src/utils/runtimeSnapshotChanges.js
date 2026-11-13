import { inferSlotWriteHistory, normalizeMemoryPath } from "./runtimeMemorySlots.js";
import { isInternalRuntimeName } from "./runtimeEventFrames.js";

const asTime = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : NaN;
};

/** A selectable state row summarizes the complete skill execution, whereas a
 * transition row is instantaneous. Each event belongs to one interval only;
 * never use the accumulated/duplicated `frame.changes` for this list. */
function frameEndSequence(frames, index, timeline, executions) {
  const frame = frames[index];
  if (!frame) return -Infinity;
  const next = frames[index + 1];
  const end =
    frame.type === "state_entered"
      ? (frame.exitSequence ??
        executions.find((item) => item.entrySequence === frame.sequence && item.state === frame.state)?.exitSequence)
      : frame.sequence;
  const unclamped = Number.isFinite(end) ? end : next ? next.sequence - 1 : (timeline?.lastSequence ?? frame.sequence);
  // Parallel/nested skill occurrences may overlap. A write in the next
  // visible snapshot must never be shown twice in the preceding snapshot.
  return Math.max(
    frame.sequence ?? -Infinity,
    next && Number.isFinite(next.sequence) ? Math.min(unclamped, next.sequence - 1) : unclamped,
  );
}

function frameIndexForSequence(bounds, sequence) {
  if (!Number.isFinite(sequence) || !bounds.length) return -1;
  // Snapshot boundaries are monotonic (even when parallel states overlap).
  // Binary search avoids scanning the entire timeline for every change.
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bounds[mid] >= sequence) high = mid;
    else low = mid + 1;
  }
  return low < bounds.length ? low : -1;
}

/** Normalize the reducer's scope-qualified IDs to the display names used by
 * Global/Local Variables. SCXML uses nested scopes; the UI groups by the name
 * prefix rather than the runtime scope name. */
function runtimeValueMap(raw = {}) {
  const result = new Map();
  for (const [key, entry] of Object.entries(raw || {})) {
    if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "value")) continue;
    const name = String(entry.name || key.split(":").at(-1));
    if (!name || isInternalRuntimeName(name)) continue;
    result.set(name, { ...entry, name });
  }
  return result;
}

/** The latest selected, unfinished skill reflects values received while the
 * engine waits for a manually sent event, not just its entry-time values. */
export function snapshotVariableValues(timeline, frame) {
  if (!frame) return {};
  const latest = timeline?.frames?.at(-1)?.id === frame.id;
  // The visible live frontier follows scope updates immediately, including
  // the interval after state_exited but before a manually fired transition.
  // Older frames continue to use their frozen final/entry values.
  const raw =
    (latest && timeline?.watching ? timeline.variables : null) || frame.finalVariables || frame.variables || {};
  return Object.fromEntries([...runtimeValueMap(raw)].map(([key, value]) => [key, value]));
}

/** Supply conservative value-diff rows when the runtime updated a scope without
 * publishing a datamodel_assignment event. This happens for some manual-event
 * runs. Event history is always preferred so multiple assignments remain
 * distinct. A difference is not fabricated when values are unchanged. */
function appendSnapshotValueDifferences(changes, timeline, frames, index) {
  const frame = frames[index];
  const previous = frames[index - 1];
  const before = runtimeValueMap(
    frame.type === "state_entered" ? frame.variables : previous?.finalVariables || previous?.variables,
  );
  const previousValues = runtimeValueMap(previous?.finalVariables || previous?.variables);
  const after = runtimeValueMap(snapshotVariableValues(timeline, frame));
  for (const [name, value] of after) {
    // A scope may initialize immediately before state_entered. The entry
    // frame already contains its new value, so use the preceding visible
    // snapshot as the baseline when one exists.
    const prior = previousValues.get(name) || before.get(name);
    // Initial declarations are not assignments. A new value needs proof
    // it was observed during this skill/transition, not in a prior scope.
    if (!prior && (!Number.isFinite(value.sequence) || value.sequence <= frame.sequence)) continue;
    if (prior && String(prior.value) === String(value.value)) continue;
    if (
      changes.some(
        (change) => change.kind === "variable" && change.name === name && String(change.value) === String(value.value),
      )
    )
      continue;
    changes.push({
      id: `inferred-variable:${frame.id}:${name}`,
      kind: "variable",
      name,
      scope: name.startsWith("_") ? "global" : "local",
      dataType: value.dataType || prior?.dataType || "",
      previous: prior?.value,
      previousKnown: Boolean(prior),
      value: value.value,
      sequence: Number.isFinite(value.sequence) ? value.sequence : frame.exitSequence || frame.sequence,
      timestamp: value.timestamp || frame.exitTimestamp || frame.timestamp,
      timeMs: asTime(value.timestamp || frame.exitTimestamp || frame.timestamp),
      inferred: true,
    });
  }

  // MemorySlot changes are never inferred from differences between adjacent
  // frame caches. Those caches are observed values, not evidence of a write.
  // Only slot_written / slot_cleared events can create MemorySlot change rows.
}

/** Show writes and assignments in the current visible skill *as they arrive*.
 * Writer inference normally anchors SSE writes to state_exited, which does not
 * exist yet while the user is waiting to fire a manual event. That historical
 * inference is still authoritative after the next snapshot appears. Only the
 * live frontier gets these temporary rows; seeking into history never does. */
function appendPendingLiveChanges(changes, timeline, frames, selectedIndex, memory, bounds, options = {}) {
  const frame = frames[selectedIndex];
  if (!timeline?.watching || !frame || selectedIndex !== frames.length - 1) return;
  const existing = new Set(changes.map((entry) => entry.id));
  const lastSequence = Number(timeline?.lastSequence);
  for (const assignment of timeline?.assignmentHistory || []) {
    const sequence = Number(assignment.sequence);
    if (
      !Number.isFinite(sequence) ||
      sequence <= frame.sequence ||
      sequence <= bounds[selectedIndex] ||
      sequence > lastSequence
    )
      continue;
    const id = `variable:${sequence}:${assignment.scope}:${assignment.key}`;
    if (existing.has(id)) continue;
    changes.push({
      id,
      kind: "variable",
      name: assignment.key,
      scope: String(assignment.key || "").startsWith("_") ? "global" : "local",
      dataType: assignment.dataType || "",
      previous: assignment.previous,
      previousKnown: assignment.oldValueKnown,
      value: assignment.value,
      sequence,
      timestamp: assignment.timestamp,
      timeMs: asTime(assignment.timestamp),
      inferred: false,
    });
    existing.add(id);
  }

  // A transition can display the latest slot *value* but never owns a slot
  // write. Likewise, a skill without a declared writable mapping must not
  // claim an unrelated SSE write merely because it arrived during the run.
  if (frame.type !== "state_entered") return;
  // SSE reception times use wall time; the entry timestamp originates from
  // the same host's SCXML backend. Never pull an older write into the active
  // row, and never use a later HTTP GET as a historical write.
  const enteredAt = asTime(frame.timestamp);
  const since = Number.isFinite(enteredAt) ? enteredAt : frame.receivedAtMs;
  if (!Number.isFinite(since)) return;
  const writerPaths = new Set((options.writerPaths || []).map(normalizeMemoryPath));
  const baseline = (memory?.observations || []).find((item) => item.kind === "pre-start");
  const previousByPath = new Map(
    (baseline?.cache || [])
      .filter((entry) => entry.status === "available")
      .map((entry) => [normalizeMemoryPath(entry.path), entry]),
  );
  const receivedWrites = (memory?.writes || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (let i = 0; i < receivedWrites.length; i += 1) {
    const write = receivedWrites[i];
    const path = normalizeMemoryPath(write.path);
    if (!path) continue;
    const observedAtMs = Number.isFinite(write.observedAtMs) ? write.observedAtMs : asTime(write.observedAt);
    const prior = previousByPath.get(path);
    const id = `slot:${path}:${write.order ?? i}`;
    // The two streams may be delivered a few milliseconds out of order.
    // A tiny grace window is safe only for a path declared writable by
    // this *selected* skill; otherwise use the strict entry timestamp.
    const graceMs = writerPaths.has(path) ? 35 : 0;
    if (writerPaths.has(path) && Number.isFinite(observedAtMs) && observedAtMs >= since - graceMs && !existing.has(id)) {
      changes.push({
        id,
        kind: "slot",
        name: path,
        path,
        scope: "slot",
        dataType: memory?.used?.[path] || memory?.live?.[path]?.type || "",
        previous: prior?.value,
        previousKnown: Boolean(prior),
        value: write.value,
        timestamp: write.observedAt,
        timeMs: observedAtMs,
        order: write.order,
        sequence: lastSequence,
        inferred: true,
        provisional: true,
        sourceState: frame.state || "",
      });
      existing.add(id);
    }
    previousByPath.set(path, write);
  }
}

/** Read all timestamped variable assignments and all individual Memory SSE
 * writes for the selected snapshot, ordered together by their timestamps.
 * Slot writer inference is the SAME inference used by the replayed values.
 * Thus rapid writes to the same slot remain distinct instead of collapsing
 * into the final value. */
export function changesForRuntimeSnapshot(timeline, frame, memory, options = {}) {
  const frames = timeline?.frames || [];
  const selectedIndex = frames.findIndex((item) => item.id === frame?.id);
  if (selectedIndex < 0) return [];
  const executions = memory?.skillExecutions || [];
  const bounds = frames.map((_, index) => frameEndSequence(frames, index, timeline, executions));
  const changes = [];
  // Map the execution identity directly to its selectable skill row. SCXML
  // transition messages and state_exited may have different event ordering;
  // sequence-range bucketing would put a write on the next transition/skill.
  const skillFrameIndexes = new Map(
    frames.flatMap((candidate, index) => candidate.type === "state_entered"
      ? [[`${candidate.state}\u0000${candidate.sequence}`, index]] : []),
  );
  for (const assignment of timeline?.assignmentHistory || []) {
    const sequence = Number(assignment.sequence);
    if (assignment.sequence == null || frameIndexForSequence(bounds, sequence) !== selectedIndex) continue;
    const scope = String(assignment.key || "").startsWith("_") ? "global" : "local";
    changes.push({
      id: `variable:${sequence}:${assignment.scope}:${assignment.key}`,
      kind: "variable",
      name: assignment.key,
      scope,
      dataType: assignment.dataType || "",
      previous: assignment.previous,
      previousKnown: assignment.oldValueKnown,
      value: assignment.value,
      sequence,
      timestamp: assignment.timestamp,
      timeMs: asTime(assignment.timestamp),
      inferred: false,
    });
  }

  const writes = memory?.writes || [];
  const paths = [...new Set(writes.map((entry) => normalizeMemoryPath(entry.path)).filter(Boolean))];
  for (const path of paths) {
    const inferred = inferSlotWriteHistory(writes, executions, path);
    const typed = memory?.used?.[path] || memory?.live?.[path]?.type || "";
    const baseline = (memory?.observations || []).find((item) => item.kind === "pre-start");
    let prior = (baseline?.cache || []).find((entry) =>
      normalizeMemoryPath(entry.path) === path && entry.status === "available",
    );
    for (const write of inferred) {
      // A write belongs to its skill execution, whose selectable row is
      // state_entered. Never allocate a MemorySlot write to a transition row.
      const index = skillFrameIndexes.get(`${write.sourceState}\u0000${write.assignedEntrySequence}`);
      if (index === selectedIndex) {
        changes.push({
          id: `slot:${path}:${write.order ?? write.localIndex}`,
          kind: "slot",
          name: path,
          path,
          scope: "slot",
          dataType: typed,
          previous: prior?.value,
          previousKnown: Boolean(prior),
          value: write.value,
          timestamp: write.observedAt,
          timeMs: Number.isFinite(write.observedAtMs) ? write.observedAtMs : asTime(write.observedAt),
          sequence: write.assignedSequence,
          order: write.order ?? write.localIndex,
          inferred: true,
          sourceState: write.sourceState,
        });
      }
      prior = write;
    }
  }
  appendPendingLiveChanges(changes, timeline, frames, selectedIndex, memory, bounds, options);
  appendSnapshotValueDifferences(changes, timeline, frames, selectedIndex);
  // SCXML timestamp originates at the backend; slot timestamps are UI SSE
  // reception times. Cross-stream ordering at equal timestamps is approximate.
  return changes.sort((a, b) => {
    const aTime = Number.isFinite(a.timeMs) ? a.timeMs : Infinity;
    const bTime = Number.isFinite(b.timeMs) ? b.timeMs : Infinity;
    if (aTime !== bTime) return aTime - bTime;
    if (a.kind === b.kind)
      return a.kind === "slot" ? (a.order ?? 0) - (b.order ?? 0) : (a.sequence ?? 0) - (b.sequence ?? 0);
    return a.kind === "variable" ? -1 : 1;
  });
}

export function formatRuntimeChangeValue(value, declaredType = "", known = true) {
  if (!known || value === undefined) return "?";
  if (value === null || value === "null") return "null";
  const raw = String(value);
  const type = String(declaredType).toLowerCase();
  const scalar = /(?:boolean|int|long|short|byte|float|double|number)/.test(type);
  if (scalar && /^(?:true|false|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|NaN|Infinity|-Infinity)$/i.test(raw)) return raw;
  return `'${raw.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
}
