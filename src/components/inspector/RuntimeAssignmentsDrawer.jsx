import { memo, useEffect, useMemo, useState } from "react";
import { FiChevronLeft, FiChevronRight, FiActivity } from "react-icons/fi";
import { inferLiteralValueType } from "../../utils/valueTypes.js";
import { getRootRuntimeVariableValues } from "../../utils/runtimeValueDisplay.js";
import {
  latestSlotObservation,
  historicalSlotValue,
  resolveRuntimeSlotObservation,
  observationForRuntimeFrame,
  configuredSkillSlots,
} from "../../utils/runtimeMemorySlots.js";
import { traceSlot, summarizeSlot, slotTraceEnabled } from "../../utils/slotReplayTrace.js";
import {
  runtimeSnapshotStateLabel,
  runtimeVariableContextLabel,
  assignmentBelongsToRuntimeSnapshot,
} from "../../utils/runtimeReplayContexts.js";
import {
  changesForRuntimeSnapshot,
  chronologicalRuntimeFrames,
  formatRuntimeChangeValue,
} from "../../utils/runtimeSnapshotChanges.js";

const valueType = (value, declaredType = "") => {
  const type = String(declaredType).toLowerCase();
  if (type.includes("boolean")) return "boolean";
  if (type.includes("string") || type.includes("char")) return "string";
  if (type.includes("double") || type.includes("float")) return "double";
  if (type.includes("int") || type.includes("long") || type.includes("short")) return "integer";
  return inferLiteralValueType(value).toLowerCase();
};

const displayState = (state) =>
  String(state || "State")
    .split(".")
    .pop()
    .replace(/#1$/, "");

function CollapsibleSection({ title, count, children, className = "", defaultOpen = true, action = null }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  return (
    <details
      className={`runtime-values-section runtime-collapsible ${className}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="runtime-section-summary">
        <span className="runtime-summary-title">
          {title} <small>{count}</small>
        </span>
        {action && (
          <span
            className="runtime-section-actions"
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
            }}
          >
            {action}
          </span>
        )}
      </summary>
      <div className="runtime-section-content">{children}</div>
    </details>
  );
}

function CurrentValues({ title, values, emptyText, invocationSuffixes = [], showContextBadges = true }) {
  return (
    <CollapsibleSection title={title} count={values.length} className="datamodel-parameter-section">
      {values.length ? (
        <div className="datamodel-compact-list">
          {values.map((entry) => {
            const type = valueType(entry.value, entry.dataType);
            const label = showContextBadges
              ? runtimeVariableContextLabel(entry.name, invocationSuffixes)
              : { name: entry.name, subMachines: [] };
            return (
              <div
                key={`${entry.owner || entry.scope}:${entry.name}`}
                className={`datamodel-compact-row datamodel-type-accent datamodel-type-accent-${type}`}
              >
                <div className="datamodel-compact-id-cell">
                  <div className="datamodel-compact-id" title={`${entry.owner || entry.scope}: ${entry.name}`}>
                    <RuntimeContextLabel label={label} />
                    {entry.owner && entry.owner !== "global" ? <small> · {entry.owner}</small> : null}
                  </div>
                  <span className={`datamodel-value-type-badge datamodel-value-type-${type}`}>{type}</span>
                </div>
                <div
                  className={`datamodel-compact-value-input runtime-readonly-value ${entry.stale ? "runtime-stale-value" : ""}`}
                  title={
                    entry.stale
                      ? "Last observed; events may have been missed"
                      : entry.initial
                        ? "SCXML initial expression"
                        : String(entry.value)
                  }
                >
                  {entry.value}
                  {entry.stale ? <small> · Stale</small> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="datamodel-empty">{emptyText}</div>
      )}
    </CollapsibleSection>
  );
}

export function RuntimeAssignmentsLedge({ open = false, onToggle }) {
  return (
    <button
      type="button"
      className="editor-panel-ledge editor-panel-ledge-assignments"
      onClick={onToggle}
      aria-controls="runtime-assignments-panel"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} run assignments`}
      title={`${open ? "Collapse" : "Expand"} run assignments`}
    >
      {open ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
      <span className="editor-panel-ledge-label">Run assignments</span>
    </button>
  );
}

function RuntimeMemorySlots({ memory, slots = [], frame, timeline }) {
  const observations = memory?.observations || [];
  const replay = !timeline?.watching;
  const eventSnapshot = replay ? observationForRuntimeFrame(observations, frame) : null;
  useEffect(() => {
    if (!slotTraceEnabled() || !replay || !frame) return;
    const checks = slots.map((slot) => ({
      path: slot.path,
      resolved: summarizeSlot(
        historicalSlotValue(observations, frame, slot.path, memory?.writes, memory?.skillExecutions),
      ),
      matchingCapturedSlots: eventSnapshot
        ? [...(eventSnapshot.slots || []), ...(eventSnapshot.cache || [])]
            .filter((item) => item.path === slot.path)
            .map(summarizeSlot)
        : null,
    }));
    const signature = JSON.stringify({ frame: frame.id, observationCount: observations.length, checks });
    traceSlot(
      "replay.inspector",
      {
        frameId: frame.id,
        frameType: frame.type,
        frameState: frame.state,
        frameSequence: frame.sequence,
        framePerf: frame.receivedAtPerf,
        captureMatched: Boolean(eventSnapshot),
        captureState: eventSnapshot?.state ?? null,
        captureEntrySequence: eventSnapshot?.entrySequence ?? null,
        observations: observations.length,
        checks,
      },
      signature,
    );
  }, [replay, frame, observations, slots, eventSnapshot]);
  const values = slots.map((slot) => {
    // The selected skill/transition snapshot owns its post-event GET sample.
    // Other slots use their own most recent observation at this historical point.
    const observed = resolveRuntimeSlotObservation(slot.candidatePaths || [slot.path], (path) =>
      replay
        ? historicalSlotValue(observations, frame, path, memory?.writes, memory?.skillExecutions)
        : memory?.live?.[path] || latestSlotObservation(observations, path),
    ) || (replay
      ? historicalSlotValue(observations, frame, slot.path, memory?.writes, memory?.skillExecutions)
      : memory?.live?.[slot.path] || latestSlotObservation(observations, slot.path));
    const available = observed?.status === "available";
    return {
      ...slot,
      observed,
      value: available
        ? observed.value
        : observed?.status === "unavailable"
          ? "Unavailable"
          : observed?.status === "not-accessed"
            ? "Not accessed"
            : replay
              ? "null"
              : memory?.used?.[slot.path]
                ? "Unavailable"
                : "Not accessed",
    };
  });
  return (
    <CollapsibleSection title="MemorySlots" count={slots.length} className="runtime-memory-slots">
      {values.length ? (
        <div className="datamodel-compact-list">
          {values.map((entry) => {
            const type = valueType(entry.value, entry.type || entry.observed?.type);
            const label = { name: entry.displayPath || entry.path, subMachines: [] };
            const inferred = replay && entry.observed?.inferred;
            const tooltip = [
              entry.path,
              entry.observed?.stale ? "Stale observation" : null,
              inferred ? `Likely written by ${displayState(entry.observed.sourceState)}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                className={`datamodel-compact-row datamodel-type-accent datamodel-type-accent-${type}`}
                key={entry.path}
              >
                <div className="datamodel-compact-id-cell">
                  <div className="datamodel-compact-id" title={entry.path}>
                    <RuntimeContextLabel label={label} />
                  </div>
                  <span className={`datamodel-value-type-badge datamodel-value-type-${type}`}>{type}</span>
                </div>
                <div
                  className={`datamodel-compact-value-input runtime-readonly-value ${entry.observed?.stale ? "runtime-stale-value" : ""}`}
                  title={[String(entry.value ?? ""), tooltip].filter(Boolean).join("\n")}
                >
                  {entry.value}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="datamodel-empty">No configured MemorySlots in the loaded workflow.</div>
      )}
      {memory?.problem && (
        <p className="runtime-assignments-warning" role="alert">
          {memory.problem}
        </p>
      )}
    </CollapsibleSection>
  );
}

function SnapshotChanges({ timeline, memory, selectedSkill, selectedSkillState, configuredSlots = [], declaredVariables = [], invocationSuffixes = [] }) {
  const frame = timeline?.frames?.[timeline?.index ?? -1];
  const allowedSlots = new Map(configuredSlots.map((slot) => [slot.path, slot.displayPath || slot.path]));
  const writable = new Set(configuredSkillSlots(selectedSkill)
    .filter((slot) => slot.access?.includes("write"))
    .map((slot) => slot.path));
  const writerPaths = frame?.type === "state_entered" && selectedSkillState === frame.state
    ? configuredSlots.filter((slot) => writable.has(slot.displayPath || slot.path)).map((slot) => slot.path)
    : [];
  const changes = changesForRuntimeSnapshot(timeline, frame, memory, { writerPaths })
    .filter((change) => change.kind === "slot"
      ? allowedSlots.has(change.path)
      : assignmentBelongsToRuntimeSnapshot(change, frame, invocationSuffixes));
  // Some runtime assignments have no declared type in their event payload.
  // Prefer the local variable's SCXML declaration before inferring a type
  // from its current value (for example, a String currently holding "null").
  const declaredTypeByName = new Map(
    declaredVariables.map((variable) => [String(variable.id || ""), variable.type || variable.valueType || ""]),
  );
  return (
    <CollapsibleSection title="Changes in this snapshot" count={changes.length} className="runtime-snapshot-changes">
      {changes.length ? (
        <div className="runtime-snapshot-change-list">
          {changes.map((change, index) => {
            const local = change.kind === "variable" && change.scope === "local";
            const type = local ? valueType(change.value, change.dataType || declaredTypeByName.get(change.name)) : null;
            const variableLabel = runtimeVariableContextLabel(change.name, invocationSuffixes);
            const snapshotContext = runtimeSnapshotStateLabel(
              frame?.type === "transition" ? frame?.transition?.source || frame?.state : frame?.state,
              invocationSuffixes,
            ).subMachines;
            const sameChildContext = snapshotContext.length > 0 &&
              snapshotContext.length === variableLabel.subMachines.length &&
              snapshotContext.every((name, position) => name === variableLabel.subMachines[position]);
            const label = {
              name: change.kind === "slot"
                ? allowedSlots.get(change.path)
                : sameChildContext ? variableLabel.name : change.name,
              subMachines: [],
            };
            return (
              <div
                key={change.id}
                className={`runtime-snapshot-change-row ${change.kind === "slot" ? "slot" : "variable"}${local ? ` local datamodel-type-accent datamodel-type-accent-${type}` : ""}`}
              >
                <div className="runtime-snapshot-change-heading" title={change.timestamp || undefined}>
                  <span className="runtime-snapshot-change-order" aria-label={`Change ${index + 1}`}>{index + 1}.</span>
                  <span className="runtime-snapshot-change-kind">
                    {change.kind === "slot" ? "MemorySlot" : change.scope === "global" ? "Global" : "Local"}
                  </span>
                </div>
                <div
                  className="runtime-snapshot-change-values"
                  title={
                    change.provisional
                      ? "Observed during current live snapshot; writer attribution is provisional"
                      : change.inferred
                        ? `Slot write attributed to ${change.sourceState || "a likely skill"} (approximate cross-stream ordering)`
                        : change.kind === "slot"
                          ? change.path
                          : `${change.scope}: ${change.name}`
                  }
                >
                  <strong className="runtime-change-identifier"><RuntimeContextLabel label={label} />:</strong>
                  <code className="runtime-change-previous">
                    {formatRuntimeChangeValue(change.previous, change.dataType, change.previousKnown)}
                  </code>
                  <span className="runtime-snapshot-change-arrow" aria-label="changed to">
                    →
                  </span>
                  <code className="runtime-change-new">{formatRuntimeChangeValue(change.value, change.dataType)}</code>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="datamodel-empty">No assignments or slot writes in this snapshot.</div>
      )}
    </CollapsibleSection>
  );
}

function SnapshotSubMachineBadges({ names = [] }) {
  return names.map((name, index) => (
    <span
      key={`${index}:${name}`}
      className="runtime-snapshot-submachine-badge"
      title={`Sub-state machine: ${name}`}
    >
      {name}
    </span>
  ));
}

function RuntimeContextLabel({ label }) {
  return (
    <span className="runtime-contextual-identifier">
      <span>{label.name}</span>
      <SnapshotSubMachineBadges names={label.subMachines} />
    </span>
  );
}

function RuntimeSnapshotLabel({ entry, invocationSuffixes = [] }) {
  const transition = entry?.transition;
  if (!transition) {
    const state = runtimeSnapshotStateLabel(entry?.state, invocationSuffixes);
    return (
      <>
        <span>{state.name}</span>
        <SnapshotSubMachineBadges names={state.subMachines} />
      </>
    );
  }
  const source = runtimeSnapshotStateLabel(transition.source, invocationSuffixes);
  const target = runtimeSnapshotStateLabel(transition.target, invocationSuffixes);
  const sharedContext = source.subMachines.length === target.subMachines.length &&
    source.subMachines.every((name, index) => name === target.subMachines[index]);
  return sharedContext ? (
    <>
      <span>{source.name} → {target.name}</span>
      <SnapshotSubMachineBadges names={source.subMachines} />
    </>
  ) : (
    <>
      <span>{source.name}</span>
      <SnapshotSubMachineBadges names={source.subMachines} />
      <span>→ {target.name}</span>
      <SnapshotSubMachineBadges names={target.subMachines} />
    </>
  );
}

function RuntimeEventHistory({ timeline, orderedFrames, selectedOrder, onSeek, onLive, onFocusSnapshot, invocationSuffixes }) {
  const start = Math.max(0, Math.min(Math.max(0, orderedFrames.length - 100), selectedOrder - 55));
  const shown = orderedFrames.slice(start, start + 100);
  return (
    <CollapsibleSection
      title="Skill & transition snapshots"
      count={orderedFrames.length}
      className="runtime-drawer-timeline"
      action={
        <button
          className="runtime-drawer-live-button"
          type="button"
          onClick={onLive}
          disabled={!orderedFrames.length}
          aria-pressed={Boolean(timeline?.watching)}
        >
          Live
        </button>
      }
    >
      {!orderedFrames.length ? (
        <p className="runtime-assignments-empty">Waiting for the next matching run.</p>
      ) : (
        <>
          <input
            type="range"
            min="0"
            max={orderedFrames.length - 1}
            value={Math.max(0, selectedOrder)}
            onChange={(event) => onSeek?.(orderedFrames[Number(event.target.value)]?.index)}
            aria-label="Seek execution timeline"
          />
          <div className="runtime-drawer-event-list">
            {shown.map(({ frame: entry, index }, relative) => {
              const order = start + relative;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`runtime-drawer-event ${order === selectedOrder ? "selected" : ""}`}
                  aria-current={order === selectedOrder ? "step" : undefined}
                  onClick={() => onSeek?.(index)}
                  onDoubleClick={() => onFocusSnapshot?.(index)}
                  title={[entry.timestamp, "Double-click to focus this snapshot and enable Follow focus"].filter(Boolean).join(" · ")}
                >
                  <span className="runtime-drawer-event-sequence">{order + 1}.</span>
                  <span className="runtime-drawer-event-label"><RuntimeSnapshotLabel entry={entry} invocationSuffixes={invocationSuffixes} /></span>
                </button>
              );
            })}
          </div>
          {orderedFrames.length > shown.length && (
            <small className="runtime-assignments-empty">
              Showing {start + 1}–{start + shown.length} of {orderedFrames.length}; use the slider to navigate.
            </small>
          )}
        </>
      )}
      {timeline?.hasGap && (
        <small className="runtime-event-stream-warning">Incomplete history: some events are missing.</small>
      )}
    </CollapsibleSection>
  );
}

function RuntimeAssignmentsDrawer({
  timeline,
  frame,
  declaredVariables = [],
  memory,
  configuredSlots = [],
  selectedSkill = null,
  selectedSkillState = null,
  open = false,
  onSeek,
  onLive,
  onFocusSnapshot,
  invocationSuffixes = [],
}) {
  const variables = getRootRuntimeVariableValues(declaredVariables, timeline, frame, invocationSuffixes);
  // Bonsai's Global/Local convention is name-based, NOT Java SCXML context:
  // _foo is globally accessible; foo is local, even if it lives in the root context.
  // Resolved #_SKILL parameters are displayed on skill nodes, never here.
  const globalVariables = variables
    .filter(({ name }) => name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const localVariables = variables
    .filter(({ name }) => !name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const frames = timeline?.frames || [];
  const orderedFrames = useMemo(() => chronologicalRuntimeFrames(frames), [frames]);
  const selectedOrder = orderedFrames.findIndex(({ index }) => index === timeline?.index);
  return (
    <aside
      id="runtime-assignments-panel"
      className={`runtime-assignments-panel ${open ? "open" : "closed"}`}
      aria-label="Run assignments"
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      <div className="runtime-assignments-content">
        <header className="runtime-assignments-header">
          <strong>
            <FiActivity /> Run assignments
          </strong>
          <small>{frames.length ? `Snapshot ${selectedOrder + 1} of ${frames.length}` : "No snapshots yet"}</small>
          {frame && (
            <span className="runtime-snapshot-heading-label" title={frame.timestamp}>
              <RuntimeSnapshotLabel entry={frame} invocationSuffixes={invocationSuffixes} />
            </span>
          )}
          {timeline?.outcome && <small>Run: {timeline.outcome}</small>}
        </header>
        <div className="runtime-assignments-scroll">
          <RuntimeEventHistory
            timeline={timeline}
            orderedFrames={orderedFrames}
            selectedOrder={selectedOrder}
            onSeek={onSeek}
            onLive={onLive}
            onFocusSnapshot={onFocusSnapshot}
            invocationSuffixes={invocationSuffixes}
          />
          <SnapshotChanges
            timeline={timeline}
            memory={memory}
            selectedSkill={selectedSkill}
            selectedSkillState={selectedSkillState}
            declaredVariables={declaredVariables}
            configuredSlots={configuredSlots}
            invocationSuffixes={invocationSuffixes}
          />
          <CurrentValues title="Global Variables" values={globalVariables} emptyText="No global variables defined." invocationSuffixes={invocationSuffixes} />
          <CurrentValues title="Local Variables" values={localVariables} emptyText="No root-local variables defined." invocationSuffixes={invocationSuffixes} showContextBadges={false} />
          <RuntimeMemorySlots memory={memory} slots={configuredSlots} frame={frame} timeline={timeline} />
          {timeline?.hasGap && (
            <p className="runtime-assignments-warning">
              Incomplete event history. Confirmed active states only; older runtime values may be stale.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}

// Other editor interactions (drag, pan, selection) do not change runtime values.
// Preserve the drawer tree until its actual runtime props change.
export default memo(RuntimeAssignmentsDrawer);
