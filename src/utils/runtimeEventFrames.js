/** Global runtime snapshots: a state frame contains ALL concurrently active states.
 * Consecutive entries are one configuration; exits and transitions form a separate
 * transition frame. Every frame freezes the complete active-state/value set.
 */
const CHANGE_TYPES = new Set(["datamodel_assignment", "slot_written", "slot_cleared"]);
const INTERNAL_NAMES = new Set(["#_SLOTS", "#_STATE_PREFIX"]);
export const isInternalRuntimeName = (name) => INTERNAL_NAMES.has(String(name ?? "").trim());
const compareChanges = (a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")) ||
    (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
export const runtimePayload = (message) => message?.data && typeof message.data === "object"
    ? message.data : message?.details && typeof message.details === "object" ? message.details : {};

const known = (value) => value === true || value === "true";
export function runtimeChange(message) {
    if (!CHANGE_TYPES.has(message.type)) return null;
    const data = runtimePayload(message);
    if (message.type === "datamodel_assignment" && isInternalRuntimeName(data.location)) return null;
    const kind = message.type.startsWith("slot_") ? "slot" : "variable";
    const key = kind === "slot" ? data.slot : data.location;
    const hasPrevious = Object.prototype.hasOwnProperty.call(data, "oldValue");
    const previousKnown = data.oldValueKnown === undefined ? hasPrevious : known(data.oldValueKnown);
    const previous = !previousKnown ? "Unknown" : data.oldValuePresent === false || data.oldValuePresent === "false"
        ? "Not set" : hasPrevious ? String(data.oldValue) : "Unknown";
    const value = message.type === "slot_cleared" ? "Cleared" : String(data.newValue ?? data.value ?? "Unknown");
    return { kind, key: String(key || "Unknown"), previous, value, timestamp: message.timestamp,
        sequence: message.sequence, source: data.sourceState || data.state || "", dataType: data.dataType || "",
        expression: data.expression || "", oldValueKnown: previousKnown };
}

export const emptyRuntimeTimeline = () => ({ frames: [], activeStates: [], status: "UNKNOWN", truncated: false,
    hasGap: false, runId: null, lastSequence: 0, variables: {}, parameters: {}, slots: {},
    completedStates: [], stateEntryHistory: [], pendingEntryAssignments: [] });

const valueOf = (data) => String(data.newValue ?? data.value ?? "Unknown");
const applyAssignment = (variables, message) => {
    const data = runtimePayload(message);
    if (!data.location || isInternalRuntimeName(data.location)) return variables;
    return { ...variables, [String(data.location)]: { value: valueOf(data), source: String(data.sourceState || "") } };
};
const transitionOf = (data) => ({ source: String(data.source || ""), target: String(data.target || ""),
    event: String(data.event || "") });

/** Pure reducer. In particular, a sibling's state_exited must never close another
 * active lane. We group adjacent entries/exits, but never invent microstep barriers
 * that the WebSocket protocol does not publish. Sequence order is retained.
 */
export function appendRuntimeEvent(previous, message, maxFrames = 5000) {
    if (!message?.type || ["hello", "resync_required"].includes(message.type)) return previous;
    const data = runtimePayload(message);
    const type = message.type;
    const active = new Set(previous.activeStates || []);
    const completed = new Set(previous.completedStates || []);
    let variables = previous.variables || {};
    let parameters = previous.parameters || {};
    let slots = previous.slots || {};
    let status = previous.status;
    let pending = previous.pendingEntryAssignments || [];
    let frames = previous.frames || [];
    let stateEntryHistory = previous.stateEntryHistory || [];
    const prior = frames.at(-1);
    const entered = type === "state_entered" && Boolean(data.state);
    const exited = type === "state_exited" && Boolean(data.state);
    const transitioned = type === "transition";
    const change = runtimeChange(message);

    if (type === "status") {
        status = String(data.value || "UNKNOWN");
        if (["UNKNOWN", "LOADING", "INITIALIZED", "INITIALIZED_BUT_WARNINGS"].includes(status)) {
            active.clear();
            completed.clear();
            pending = [];
            stateEntryHistory = [];
        }
    }
    if (type === "stopped") { active.clear(); pending = []; }
    if (entered) {
        active.add(String(data.state)); completed.delete(String(data.state));
        stateEntryHistory = [...stateEntryHistory, { state: String(data.state), sequence: message.sequence }].slice(-256);
    }
    if (type === "terminal" && data.state) completed.add(String(data.state));
    if (exited) active.delete(String(data.state));

    // An onentry assign may precede state_entered. Buffer it if the owning state
    // is not yet active; never leak the future value into the outgoing snapshot.
    const sourceState = String(data.sourceState || "");
    const earlyEntry = type === "datamodel_assignment" && sourceState && !active.has(sourceState)
        && !isInternalRuntimeName(data.location)
        && !(prior?.exitedStates || []).includes(sourceState);
    if (earlyEntry) pending = [...pending, message];
    else if (type === "datamodel_assignment") variables = applyAssignment(variables, message);

    if (type === "parameter" && data.name && !isInternalRuntimeName(data.name)) {
        const state = String(data.state || "");
        const name = String(data.name);
        parameters = { ...parameters, [`${state}:${name}`]: {
            name, state, value: String(data.value ?? "Unknown"), timestamp: message.timestamp,
        } };
    }
    if ((type === "slot_written" || type === "slot_cleared") && data.slot) {
        const path = `/${String(data.slot).replace(/^\/+/, "")}`;
        slots = { ...slots, [path]: {
            value: type === "slot_cleared" ? "Cleared" : valueOf(data),
            timestamp: message.timestamp, state: data.sourceState || data.state || "", dataType: data.dataType || "",
        } };
    }

    const matching = entered ? pending.filter((entry) =>
        String(runtimePayload(entry).sourceState || "") === String(data.state)) : [];
    if (matching.length) {
        for (const entry of matching) variables = applyAssignment(variables, entry);
        pending = pending.filter((entry) => !matching.includes(entry));
    }
    const resetEvent = type === "stopped" || type === "terminal" ||
        (type === "status" && ["UNKNOWN", "LOADING", "INITIALIZED", "INITIALIZED_BUT_WARNINGS"].includes(status));
    if (resetEvent && pending.length) {
        // An unmatched assign is observable, but its intended state never entered.
        // Keep the event on its preceding frame instead of dropping it.
        if (prior) {
            frames = [...frames.slice(0, -1), { ...prior,
                events: [...prior.events, ...pending],
                changes: [...prior.changes, ...pending.map(runtimeChange).filter(Boolean)].sort(compareChanges),
            }];
        }
        pending = [];
    }

    const record = entered || exited || transitioned || type === "terminal"
        || (change && !earlyEntry) || (type === "parameter" && !isInternalRuntimeName(data.name));
    if (record) {
        const last = frames.at(-1);
        // Adjacent state entries (Parallel + lanes + their initial skills) share a
        // single frame. Sibling exits and multiple transitions share another.
        const phase = entered ? "entering" : (exited || transitioned ? "exiting" : last?.phase || "active");
        const newFrame = !last || (entered && last.phase !== "entering")
            || ((exited || transitioned) && last.kind !== "transition")
            || (type === "terminal" && last.phase === "entering" && !completed.has(String(last.state)));
        const frame = newFrame ? {
            id: `${message.runId || "run"}:${message.sequence ?? `${message.timestamp}:${frames.length}`}`,
            kind: entered ? "state" : "transition", phase,
            state: entered ? String(data.state) : "", enteredStates: [], exitedStates: [],
            exitingStates: exited ? [...(previous.activeStates || [])] : [],
            completedStates: [], finishedStates: [], transition: null, transitions: [],
            timestamp: matching[0]?.timestamp || message.timestamp,
            events: [], changes: [], activeStates: [], variables: {}, parameters: {}, slots: {},
            closed: false,
        } : last;
        const transitions = transitioned ? [...(frame.transitions || []), transitionOf(data)] : frame.transitions || [];
        const next = { ...frame, phase,
            kind: entered ? "state" : (exited || transitioned ? "transition" : frame.kind),
            state: entered ? (frame.state || String(data.state)) : frame.state,
            enteredStates: entered ? [...frame.enteredStates, String(data.state)] : frame.enteredStates,
            exitedStates: exited ? [...frame.exitedStates, String(data.state)] : frame.exitedStates,
            exitingStates: frame.exitingStates.length ? frame.exitingStates
                : exited ? [...(previous.activeStates || [])] : [],
            completedStates: type === "terminal" && data.state
                ? [...frame.completedStates, String(data.state)] : frame.completedStates,
            finishedStates: [...completed], stateEntryHistory,
            transitions, transition: transitions.at(-1) || null,
            events: [...frame.events, ...matching, message],
            changes: [...frame.changes, ...matching.map(runtimeChange).filter(Boolean),
                ...(change && !earlyEntry ? [change] : [])].sort(compareChanges),
            activeStates: [...active], variables, parameters, slots,
            closed: exited || type === "terminal",
        };
        frames = newFrame ? [...frames, next] : [...frames.slice(0, -1), next];
        if (frames.length > maxFrames) frames = frames.slice(-maxFrames);
    }
    return { ...previous, frames, activeStates: [...active], completedStates: [...completed], stateEntryHistory,
        variables, parameters, slots, status, pendingEntryAssignments: pending,
        lastSequence: Number.isSafeInteger(message.sequence) ? message.sequence : previous.lastSequence,
        runId: message.runId || previous.runId,
        truncated: previous.truncated || frames.length >= maxFrames };
}
