import { useEffect, useState } from "react";
import { FiChevronLeft, FiChevronRight, FiActivity } from "react-icons/fi";
import { inferLiteralValueType } from "../../utils/valueTypes.js";
import { getRuntimeVariableValues } from "../../utils/runtimeValueDisplay.js";
import { latestSlotObservation, historicalSlotValue, observationForRuntimeFrame, configuredSkillSlots } from "../../utils/runtimeMemorySlots.js";
import { traceSlot, summarizeSlot } from "../../utils/slotReplayTrace.js";
import { changesForRuntimeSnapshot, formatRuntimeChangeValue, snapshotVariableValues } from "../../utils/runtimeSnapshotChanges.js";

const valueType = (value, declaredType = "") => {
    const type = String(declaredType).toLowerCase();
    if (type.includes("boolean")) return "boolean";
    if (type.includes("string") || type.includes("char")) return "string";
    if (type.includes("double") || type.includes("float")) return "double";
    if (type.includes("int") || type.includes("long") || type.includes("short")) return "integer";
    return inferLiteralValueType(value).toLowerCase();
};

const displayState = (state) => String(state || "State").split(".").pop().replace(/#1$/, "");

function CollapsibleSection({ title, count, children, className = "", defaultOpen = true, action = null }) {
    const [expanded, setExpanded] = useState(defaultOpen);
    return <details className={`runtime-values-section runtime-collapsible ${className}`}
        open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="runtime-section-summary">
            <span className="runtime-summary-title">{title} <small>{count}</small></span>
            {action && <span className="runtime-section-actions" onClick={(event) => {
                event.stopPropagation(); event.preventDefault();
            }}>{action}</span>}
        </summary>
        <div className="runtime-section-content">{children}</div>
    </details>;
}

function CurrentValues({ title, values, emptyText }) {
    return <CollapsibleSection title={title} count={values.length} className="datamodel-parameter-section">
        {values.length ? <div className="datamodel-compact-list">{values.map((entry) => {
            const type = valueType(entry.value, entry.dataType);
            return <div key={`${entry.owner || entry.scope}:${entry.name}`}
                className={`datamodel-compact-row datamodel-type-accent datamodel-type-accent-${type}`}>
                <div className="datamodel-compact-id-cell">
                    <div className="datamodel-compact-id" title={`${entry.owner || entry.scope}: ${entry.name}`}>
                        {entry.name}{entry.owner && entry.owner !== "global" ? <small> · {entry.owner}</small> : null}
                    </div>
                    <span className={`datamodel-value-type-badge datamodel-value-type-${type}`}>{type}</span>
                </div>
                <div className={`datamodel-compact-value-input runtime-readonly-value ${entry.stale ? "runtime-stale-value" : ""}`}
                    title={entry.stale ? "Last observed; events may have been missed" : entry.initial ? "SCXML initial expression" : String(entry.value)}>
                    {entry.value}{entry.stale ? <small> · Stale</small> : null}
                </div>
            </div>;
        })}</div> : <div className="datamodel-empty">{emptyText}</div>}
    </CollapsibleSection>;
}

export function RuntimeAssignmentsLedge({ open = false, onToggle }) {
    return <button type="button" className="editor-panel-ledge editor-panel-ledge-assignments"
        onClick={onToggle} aria-controls="runtime-assignments-panel" aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} run assignments`}
        title={`${open ? "Collapse" : "Expand"} run assignments`}>
        {open ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
        <span className="editor-panel-ledge-label">Run assignments</span>
    </button>;
}

function RuntimeMemorySlots({ memory, slots = [], frame, timeline }) {
    const observations = memory?.observations || [];
    const replay = !timeline?.watching;
    const eventSnapshot = replay ? observationForRuntimeFrame(observations, frame) : null;
    useEffect(() => {
        if (!replay || !frame) return;
        const checks = slots.map((slot) => ({ path: slot.path,
            resolved: summarizeSlot(historicalSlotValue(observations, frame, slot.path, memory?.writes, memory?.skillExecutions)),
            matchingCapturedSlots: eventSnapshot
                ? [...(eventSnapshot.slots || []), ...(eventSnapshot.cache || [])]
                    .filter((item) => item.path === slot.path).map(summarizeSlot) : null }));
        const signature = JSON.stringify({ frame: frame.id, observationCount: observations.length, checks });
        traceSlot("replay.inspector", { frameId: frame.id, frameType: frame.type,
            frameState: frame.state, frameSequence: frame.sequence,
            framePerf: frame.receivedAtPerf, captureMatched: Boolean(eventSnapshot),
            captureState: eventSnapshot?.state ?? null,
            captureEntrySequence: eventSnapshot?.entrySequence ?? null,
            observations: observations.length, checks }, signature);
    }, [replay, frame, observations, slots, eventSnapshot]);
    const values = slots.map((slot) => {
        // The selected skill/transition snapshot owns its post-event GET sample.
        // Other slots use their own most recent observation at this historical point.
        const observed = replay ? historicalSlotValue(observations, frame, slot.path, memory?.writes, memory?.skillExecutions)
            : memory?.live?.[slot.path] || latestSlotObservation(observations, slot.path);
        const available = observed?.status === "available";
        return { ...slot, observed, value: available ? observed.value
            : observed?.status === "unavailable" ? "Unavailable"
                : observed?.status === "not-accessed" ? "Not accessed"
                    : replay ? "null" : memory?.used?.[slot.path] ? "Unavailable" : "Not accessed",
        };
    });
    return <CollapsibleSection title="MemorySlots" count={slots.length} className="runtime-memory-slots">
        {values.length ? <div className="datamodel-compact-list">{values.map((entry) => {
            const type = valueType(entry.value, entry.type || entry.observed?.type);
            const inferred = replay && entry.observed?.inferred;
            const tooltip = [entry.path,
                entry.observed?.stale ? "Stale observation" : null,
                inferred ? `Likely written by ${displayState(entry.observed.sourceState)}` : null,
            ].filter(Boolean).join(" · ");
            return <div className={`datamodel-compact-row datamodel-type-accent datamodel-type-accent-${type}`}
                key={entry.path}>
                <div className="datamodel-compact-id-cell">
                    <div className="datamodel-compact-id" title={entry.path}>{entry.path}</div>
                    <span className={`datamodel-value-type-badge datamodel-value-type-${type}`}>{type}</span>
                </div>
                <div className={`datamodel-compact-value-input runtime-readonly-value ${entry.observed?.stale ? "runtime-stale-value" : ""}`}
                    title={tooltip}>
                    {entry.value}
                </div>
            </div>;
        })}</div> : <div className="datamodel-empty">No configured MemorySlots in the loaded workflow.</div>}
        {memory?.problem && <p className="runtime-assignments-warning" role="alert">{memory.problem}</p>}
    </CollapsibleSection>;
}

function SnapshotChanges({ timeline, memory, selectedSkill, selectedSkillState, declaredVariables = [] }) {
    const frame = timeline?.frames?.[timeline?.index ?? -1];
    const writerPaths = frame?.type === "state_entered" && selectedSkillState === frame.state
        ? configuredSkillSlots(selectedSkill).filter((slot) => slot.access?.includes("write"))
            .map((slot) => slot.path).filter(Boolean)
        : [];
    const changes = changesForRuntimeSnapshot(timeline, frame, memory, { writerPaths });
    // Some runtime assignments have no declared type in their event payload.
    // Prefer the local variable's SCXML declaration before inferring a type
    // from its current value (for example, a String currently holding "null").
    const declaredTypeByName = new Map(declaredVariables.map((variable) => [
        String(variable.id || ""), variable.type || variable.valueType || "",
    ]));
    return <CollapsibleSection title="Changes in this snapshot" count={changes.length}
        className="runtime-snapshot-changes">
        {changes.length ? <div className="runtime-snapshot-change-list">
            {changes.map((change) => {
                const local = change.kind === "variable" && change.scope === "local";
                const type = local ? valueType(change.value, change.dataType || declaredTypeByName.get(change.name)) : null;
                return <div key={change.id}
                    className={`runtime-snapshot-change-row ${change.kind === "slot" ? "slot" : "variable"}${local ? ` local datamodel-type-accent datamodel-type-accent-${type}` : ""}`}>
                    <div className="runtime-snapshot-change-heading">
                        <span className="runtime-snapshot-change-kind">{change.kind === "slot" ? "MemorySlot"
                            : change.scope === "global" ? "Global" : "Local"}</span>
                    </div>
                    <div className="runtime-snapshot-change-values" title={change.provisional
                        ? "Observed during current live snapshot; writer attribution is provisional"
                        : change.inferred
                        ? `Slot write attributed to ${change.sourceState || "a likely skill"} (approximate cross-stream ordering)`
                        : change.kind === "slot" ? change.path : `${change.scope}: ${change.name}`}>
                        <strong>{change.name}:</strong>
                        <code className="runtime-change-previous">{formatRuntimeChangeValue(change.previous, change.dataType, change.previousKnown)}</code>
                        <span className="runtime-snapshot-change-arrow" aria-label="changed to">→</span>
                        <code className="runtime-change-new">{formatRuntimeChangeValue(change.value, change.dataType)}</code>
                    </div>
                </div>;
            })}
        </div> : <div className="datamodel-empty">No assignments or slot writes in this snapshot.</div>}
    </CollapsibleSection>;
}

function RuntimeEventHistory({ timeline, onSeek, onLive }) {
    const frames = timeline?.frames || [];
    const selected = timeline?.index ?? -1;
    const start = Math.max(0, Math.min(Math.max(0, frames.length - 100), selected - 55));
    const shown = frames.slice(start, start + 100);
    const eventLabel = (entry) => entry.type === "transition"
        ? `${displayState(entry.transition?.source)} → ${displayState(entry.transition?.target)}`
        : displayState(entry.state);
    return <CollapsibleSection title="Skill & transition snapshots" count={frames.length}
        className="runtime-drawer-timeline"
        action={<button className="runtime-drawer-live-button" type="button" onClick={onLive}
            disabled={!frames.length} aria-pressed={Boolean(timeline?.watching)}>Live</button>}>
        {!frames.length ? <p className="runtime-assignments-empty">Waiting for the next matching run.</p> : <>
            <input type="range" min="0" max={frames.length - 1} value={Math.max(0, selected)}
                onChange={(event) => onSeek?.(Number(event.target.value))}
                aria-label="Seek execution timeline" />
            <div className="runtime-drawer-event-list">
                {shown.map((entry, relative) => {
                    const index = start + relative;
                    return <button key={entry.id} type="button" className={`runtime-drawer-event ${index === selected ? "selected" : ""}`}
                        aria-current={index === selected ? "step" : undefined} onClick={() => onSeek?.(index)}
                        title={entry.timestamp || ""}>
                        <span className="runtime-drawer-event-sequence">{index + 1}</span>
                        <span className="runtime-drawer-event-label">{eventLabel(entry)}</span>
                    </button>;
                })}
            </div>
            {frames.length > shown.length && <small className="runtime-assignments-empty">
                Showing {start + 1}–{start + shown.length} of {frames.length}; use the slider to navigate.
            </small>}
        </>}
        {timeline?.hasGap && <small className="runtime-event-stream-warning">Incomplete history: some events are missing.</small>}
    </CollapsibleSection>;
}

export default function RuntimeAssignmentsDrawer({ timeline, frame, declaredVariables = [], memory,
    configuredSlots = [], selectedSkill = null, selectedSkillState = null, open = false, onSeek, onLive }) {
    const variables = getRuntimeVariableValues(declaredVariables, snapshotVariableValues(timeline, frame));
    // Bonsai's Global/Local convention is name-based, NOT Java SCXML context:
    // _foo is globally accessible; foo is local, even if it lives in the root context.
    // Resolved #_SKILL parameters are displayed on skill nodes, never here.
    const globalVariables = variables.filter(({ name }) => name.startsWith("_")).sort((a, b) => a.name.localeCompare(b.name));
    const localVariables = variables.filter(({ name }) => !name.startsWith("_")).sort((a, b) => a.name.localeCompare(b.name));
    const frames = timeline?.frames || [];
    return <aside id="runtime-assignments-panel" className={`runtime-assignments-panel ${open ? "open" : "closed"}`}
        aria-label="Run assignments" aria-hidden={!open} inert={!open ? true : undefined}>
        <div className="runtime-assignments-content">
            <header className="runtime-assignments-header">
                <strong><FiActivity /> Run assignments</strong>
                <small>{frames.length ? `Snapshot ${timeline.index + 1} of ${frames.length}` : "No snapshots yet"}</small>
                {frame && <span title={frame.timestamp}>{frame.kind === "state" ? displayState(frame.state)
                    : frame.transition ? `${displayState(frame.transition.source)} → ${displayState(frame.transition.target)}` : ""}</span>}
                {timeline?.outcome && <small>Run: {timeline.outcome}</small>}
            </header>
            <div className="runtime-assignments-scroll">
                <RuntimeEventHistory timeline={timeline} onSeek={onSeek} onLive={onLive} />
                <SnapshotChanges timeline={timeline} memory={memory}
                    selectedSkill={selectedSkill} selectedSkillState={selectedSkillState}
                    declaredVariables={declaredVariables} />
                <CurrentValues title="Global Variables" values={globalVariables}
                    emptyText="No global variables defined." />
                <CurrentValues title="Local Variables" values={localVariables}
                    emptyText="No local variables defined." />
                <RuntimeMemorySlots memory={memory} slots={configuredSlots} frame={frame} timeline={timeline} />
                {timeline?.hasGap && <p className="runtime-assignments-warning">Incomplete event history. Confirmed active states only; older runtime values may be stale.</p>}
            </div>
        </div>
    </aside>;
}
