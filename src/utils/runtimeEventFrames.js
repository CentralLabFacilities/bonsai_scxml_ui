/** Deterministic, per-event live SCXML reducer. Hidden events change the runtime
 * state but never manufacture a visible timeline step. Each visible frame freezes
 * its own historical state, including scoped variables and stale indicators. */
const INTERNAL_NAMES = new Set(["#_SLOTS", "#_STATE_PREFIX"]);
export const isInternalRuntimeName = (name) => INTERNAL_NAMES.has(String(name ?? "").trim());
export const runtimePayload = (message) => message?.details && typeof message.details === "object"
    ? message.details : message?.data && typeof message.data === "object" ? message.data : {};
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const truth = (value) => value === true || value === "true";

export const emptyRuntimeTimeline = () => ({ frames: [], activeStates: [], status: "UNKNOWN", truncated: false,
    hasGap: false, partiallyUnknown: false, lastSequence: 0, runId: null, outcome: null, scopes: {},
    variables: {}, parameters: {}, slots: {}, completedStates: [], stateEntryHistory: [],
    pendingEntryAssignments: [], lastEvent: null, pendingChanges: [], assignmentHistory: [],
    skillEntryCounts: {} });

/** Prefer type-preserving JSON fields; the old display strings are fallback only. */
function typedValue(json, fallback) {
    if (typeof json === "string") {
        try {
            const parsed = JSON.parse(json);
            if (parsed && typeof parsed === "object" && parsed.$bonsaiUnsupportedType)
                return { value: `[Unsupported: ${parsed.$bonsaiUnsupportedType}]`, dataType: parsed.$bonsaiUnsupportedType };
            return { value: parsed === null ? "null" : typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed),
                dataType: parsed === null ? "null" : typeof parsed };
        } catch { /* fall back to explicitly supplied formatted value */ }
    }
    if (fallback && typeof fallback === "object" && fallback.$bonsaiUnsupportedType)
        return { value: `[Unsupported: ${fallback.$bonsaiUnsupportedType}]`, dataType: fallback.$bonsaiUnsupportedType };
    return { value: fallback === null ? "null" : typeof fallback === "object" ? JSON.stringify(fallback) : String(fallback ?? "Unknown"),
        dataType: typeof fallback };
}
function initializedValues(data, message) {
    let raw = data.values;
    if (typeof data.valuesJson === "string") {
        try { raw = JSON.parse(data.valuesJson); } catch { /* values fallback */ }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = message.values || {};
    return Object.fromEntries(Object.entries(raw).filter(([key]) => !isInternalRuntimeName(key))
        .map(([name, value]) => [name, { ...typedValue(undefined, value), stale: false,
            sequence: message.sequence, timestamp: message.timestamp }]));
}
function flattenScopes(scopes) {
    // Preserve the owning scope even if multiple states declare the same ID.
    return Object.fromEntries(Object.entries(scopes).flatMap(([scope, entries]) =>
        Object.entries(entries).map(([name, entry]) => [`${scope}:${name}`, { ...entry, name, scope }])));
}
export function runtimeChange(message) {
    if (message?.type !== "datamodel_assignment") return null;
    const data = runtimePayload(message);
    if (!data.location || isInternalRuntimeName(data.location)) return null;
    const next = typedValue(data.newValueJson, data.newValue ?? data.value);
    const previousKnown = truth(data.oldValueKnown) || (has(data, "oldValue") && !has(data, "oldValueKnown"));
    return { kind: "variable", key: String(data.location), scope: String(data.scope || "global"),
        previous: previousKnown ? String(data.oldValue) : "Unknown", oldValueKnown: previousKnown,
        value: next.value, dataType: data.newValueType || next.dataType,
        source: String(data.sourceState || ""), expression: String(data.expression || ""),
        timestamp: message.timestamp, sequence: message.sequence };
}
const transitionOf = (data) => ({ source: String(data.source || ""), target: String(data.target || ""),
    event: String(data.event || ""), declaredEvent: String(data.declaredEvent || "") });

export function appendRuntimeEvent(previous, message, maxFrames = 5000) {
    if (!message?.type || ["hello", "resync_required"].includes(message.type)) return previous;
    const data = runtimePayload(message);
    const type = message.type;
    const active = new Set(previous.activeStates || []);
    let scopes = previous.scopes || {};
    let parameters = previous.parameters || {};
    let status = previous.status;
    let outcome = previous.outcome;
    let history = previous.stateEntryHistory || [];
    let partiallyUnknown = previous.partiallyUnknown;
    let skillEntryCounts = previous.skillEntryCounts || {};
    if (type === "status") status = String(data.value || "UNKNOWN");
    if (type === "started") { status = "RUNNING"; outcome = null; partiallyUnknown = false; }
    if (type === "completed") { outcome = data.outcome === "failure" ? "failure" : "success";
        status = outcome === "failure" ? "FAILED" : "COMPLETED"; active.clear(); }
    if (type === "stopped") { status = "STOPPED"; outcome = "stopped"; active.clear(); }
    if (type === "state_entered" && data.state) {
        // Skill parameters are execution-local: never show previous invocation's
        // resolved values while the next invocation has not resolved its own.
        const prefix = `${String(data.state)}:`;
        parameters = Object.fromEntries(Object.entries(parameters).filter(([key]) => !key.startsWith(prefix)));
        active.add(String(data.state));
        history = [...history, { state: String(data.state), sequence: message.sequence }].slice(-256);
        if (message.skillSnapshot !== false && !/^(?:End|Fatal)$/i.test(String(data.state).split(/[.#]/)[0])) {
            skillEntryCounts = { ...skillEntryCounts, [String(data.state)]: (skillEntryCounts[String(data.state)] || 0) + 1 };
        }
    }
    if (type === "state_exited" && data.state) active.delete(String(data.state));
    if (type === "datamodel_scope_initialized" && data.scope) {
        scopes = { ...scopes, [String(data.scope)]: initializedValues(data, message) };
    }
    const change = runtimeChange(message);
    // Preserve each assignment as a distinct timestamped event. `frame.changes`
    // is a visual summary and may contain repeats when a skill exits; it must
    // not be used as the source for a chronological assignment history.
    let assignmentHistory = previous.assignmentHistory || [];
    if (change) {
        const scope = change.scope;
        const preceding = scopes[scope]?.[change.key];
        const historicalChange = !change.oldValueKnown && preceding && Object.hasOwn(preceding, "value")
            ? { ...change, previous: String(preceding.value), oldValueKnown: true }
            : change;
        assignmentHistory = [...assignmentHistory, historicalChange].slice(-5000);
        scopes = { ...scopes, [scope]: { ...(scopes[scope] || {}), [change.key]: {
            ...typedValue(data.newValueJson, data.newValue ?? data.value), dataType: data.newValueType || change.dataType,
            stale: false, timestamp: message.timestamp, sequence: message.sequence, source: change.source,
        } } };
    }
    if (type === "parameter" && data.name && !isInternalRuntimeName(data.name)) {
        const state = String(data.state || "");
        const name = String(data.name);
        parameters = { ...parameters, [`${state}:${name}`]: {
            state, name, value: String(data.newValue ?? data.value ?? "Unknown"),
            expression: String(data.expression || ""), stale: false, timestamp: message.timestamp,
        } };
    }
    // A skill gets exactly one selectable snapshot when it enters. Exiting it
    // finalizes that same occurrence; it never creates a duplicate timeline row.
    // Transitions remain independent snapshots. Non-skill entry/exit events
    // still update the active-state set and historical variable state.
    const skillEntry = type === "state_entered" && message.skillSnapshot !== false
        && !/^(?:End|Fatal)$/i.test(String(data.state || "").split(/[.#]/)[0]);
    const focused = skillEntry || type === "transition";
    // Keep assignments between two snapshots rather than dropping them when
    // their individual timeline rows are hidden. This is a time interval, not
    // proof that the exiting skill wrote the variable.
    const pendingChanges = change ? [...(previous.pendingChanges || []), change].slice(-2000)
        : (previous.pendingChanges || []);
    const transition = type === "transition" ? transitionOf(data) : null;
    const variables = flattenScopes(scopes);
    const frames = focused ? [...previous.frames, {
        id: `${message.sequence ?? message.timestamp ?? previous.frames.length}:${type}`,
        sequence: message.sequence, timestamp: message.timestamp, receivedAtMs: Date.now(), receivedAtPerf: performance.now(), type,
        kind: type === "transition" ? "transition" : "state",
        occurrence: skillEntry ? skillEntryCounts[String(data.state)] : undefined,
        phase: type === "transition" ? "exiting" : "entering",
        state: String(data.state || data.sourceState || ""), enteredStates: skillEntry ? [String(data.state)] : [],
        exitedStates: [], exitingStates: [],
        transition, transitions: transition ? [transition] : [],
        completedStates: [], finishedStates: [], stateEntryHistory: history,
        events: [message], changes: pendingChanges,
        activeStates: [...active], scopes, variables, parameters, slots: previous.slots || {},
        partiallyUnknown, closed: false,
    }] : previous.frames;
    const lastEvent = ["started", "state_entered", "state_exited", "transition", "parameter",
        "datamodel_assignment", "completed", "stopped"].includes(type) ? {
        type, sequence: message.sequence, timestamp: message.timestamp,
        state: String(data.state || data.sourceState || (transition?.target || "")),
        transition,
    } : previous.lastEvent;
    let finalized = frames;
    // Preserve a skill's changing parameters and datamodel over its execution;
    // the entry snapshot is its execution summary, finalized at exit.
    if (type === "state_exited" && data.state) {
        const index = [...frames].map((item) => item.type === "state_entered" && item.state === String(data.state) && !item.closed).lastIndexOf(true);
        if (index >= 0) {
            const prior = frames[index];
            finalized = [...frames];
            finalized[index] = { ...prior, closed: true, exitSequence: message.sequence,
                exitTimestamp: message.timestamp, finalScopes: scopes,
                finalVariables: variables, finalParameters: parameters,
                // Graph state remains the entry-time state for historical highlighting.
                changes: [...(prior.changes || []), ...pendingChanges] };
        }
    }
    const clipped = finalized.length > maxFrames ? finalized.slice(-maxFrames) : finalized;
    return { ...previous, status, outcome, activeStates: [...active], stateEntryHistory: history, scopes, variables,
        parameters, partiallyUnknown, frames: clipped, truncated: previous.truncated || finalized.length > maxFrames,
        skillEntryCounts, assignmentHistory,
        pendingChanges: focused ? [] : (type === "state_exited" ? [] : pendingChanges), lastEvent, lastSequence: Number.isSafeInteger(message.sequence) ? message.sequence : previous.lastSequence };
}

/** Invalidate only current truth. Historical frames remain unchanged. */
export function invalidateRuntimeTimeline(previous) {
    const stale = (entries) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { ...value, stale: true }]));
    const scopes = Object.fromEntries(Object.entries(previous.scopes || {}).map(([key, value]) => [key, stale(value)]));
    return { ...previous, hasGap: true, partiallyUnknown: true, activeStates: [], scopes,
        variables: flattenScopes(scopes), parameters: stale(previous.parameters || {}) };
}
