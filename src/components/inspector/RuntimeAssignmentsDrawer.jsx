import { FiChevronLeft, FiChevronRight, FiActivity } from "react-icons/fi";
import { inferLiteralValueType } from "../../utils/valueTypes.js";
import { getRuntimeVariableValues, getActiveRuntimeParameters } from "../../utils/runtimeValueDisplay.js";

// Runtime values are formatted strings, not typed values. Prefer an explicit
// event type where available; otherwise use the same literal-type inference as
// the workflow Details panel.
const valueType = (value, declaredType = "") => {
    const type = String(declaredType).toLowerCase();
    if (type.includes("boolean")) return "boolean";
    if (type.includes("string") || type.includes("char")) return "string";
    if (type.includes("double") || type.includes("float")) return "double";
    if (type.includes("int") || type.includes("long") || type.includes("short")) return "integer";
    return inferLiteralValueType(value).toLowerCase();
};

// Mirror WorkflowPanel's Global / Local Variables cards, but keep the values
// read-only: runtime observations must never edit the SCXML datamodel.
function CurrentValues({ title, hint, values, emptyText }) {
    return <section className="datamodel-parameter-section runtime-values-section">
        <div className="datamodel-section-header">
            <h3>{title}</h3>
            <span className="datamodel-section-hint">{hint}</span>
        </div>
        {values.length ? <div className="datamodel-compact-list">{values.map((entry) => {
            const type = valueType(entry.value, entry.dataType);
            return <div key={entry.name}
                className={`datamodel-compact-row datamodel-type-accent datamodel-type-accent-${type}`}>
                <div className="datamodel-compact-id-cell">
                    <div className="datamodel-compact-id" title={entry.name}>{entry.name}</div>
                    <span className={`datamodel-value-type-badge datamodel-value-type-${type}`}>
                        {type}
                    </span>
                </div>
                <div className="datamodel-compact-value-input runtime-readonly-value" title={entry.initial ? "SCXML initial expression; no runtime value observed yet" : entry.value}>
                    {entry.value}
                </div>
            </div>;
        })}</div> : <div className="datamodel-empty">{emptyText}</div>}
    </section>;
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

export default function RuntimeAssignmentsDrawer({ timeline, frame, declaredVariables = [],
    open = false }) {
    const variables = getRuntimeVariableValues(declaredVariables, frame?.variables);
    const globalVariables = variables.filter(({ scope }) => scope === "global").sort((a, b) => a.name.localeCompare(b.name));
    const localVariables = variables.filter(({ scope }) => scope === "local").sort((a, b) => a.name.localeCompare(b.name));
    const parameters = getActiveRuntimeParameters(frame);
    const frames = timeline?.frames || [];
    return <aside id="runtime-assignments-panel" className={`runtime-assignments-panel ${open ? "open" : "closed"}`}
        aria-label="Run assignments" aria-hidden={!open} inert={!open ? true : undefined}>
        <div className="runtime-assignments-content">
            <header className="runtime-assignments-header">
                <strong><FiActivity /> Run assignments</strong>
                <small>{frames.length ? `Snapshot ${timeline.index + 1} of ${frames.length}` : "No snapshots yet"}</small>
                {frame && <span title={frame.timestamp}>{frame.kind === "state" ? frame.state
                    : frame.transition ? `${frame.transition.source} → ${frame.transition.target}` : "Transition"}</span>}
            </header>
            <div className="runtime-assignments-scroll">
                <CurrentValues title="Global Variables" hint="Names starting with _" values={globalVariables}
                    emptyText="No global variables defined." />
                <CurrentValues title="Local Variables" hint="All other names" values={localVariables}
                    emptyText="No local variables defined." />
                <section className="runtime-values-section">
                    <h4>Assignments <span>{frame?.changes?.length || 0}</span></h4>
                    {frame?.changes?.length ? <div className="runtime-assignments-list" key={frame.id}>
                        {frame.changes.map((change, index) => <div
                            className={`runtime-assignment-row ${change.kind} datamodel-type-accent datamodel-type-accent-${valueType(change.value, change.dataType)}`}
                            key={`${change.sequence ?? change.timestamp}-${index}`}
                            style={{ animationDelay: `${Math.min(index * 45, 500)}ms` }}>
                            <div className="runtime-assignment-row-heading">
                                <code title={change.dataType || ""}>{change.key}</code>
                                <span>{change.kind === "slot" ? "Slot" : "Variable"}</span>
                            </div>
                            <div className="runtime-assignment-values"><span title={change.oldValueKnown ? "Previous value" : "Previous value unavailable"}>
                                {change.previous}</span><b aria-label="changed to">→</b><strong>{change.value}</strong></div>
                            {change.source && <small>{change.source}</small>}
                        </div>)}
                    </div> : <p className="runtime-assignments-empty">No variable or slot assignments in this snapshot.</p>}
                </section>
                <section className="runtime-values-section">
                    <h4>Resolved Skill Parameters <span>{parameters.length}</span></h4>
                    {parameters.length ? <div className="runtime-values-list">{parameters.map((entry) => {
                        const type = valueType(entry.value);
                        return <div className={`runtime-value-row datamodel-type-accent datamodel-type-accent-${type}`}
                            key={`${entry.state}:${entry.name}`}>
                            <div><code>{entry.name}</code></div>
                            <span className="runtime-parameter-value" title={entry.value}>{entry.value}</span>
                            <span className={`datamodel-value-type-badge datamodel-value-type-${type}`}>{type}</span>
                        </div>;
                    })}</div> : <p className="runtime-assignments-empty">No resolved parameters yet.</p>}
                </section>
                {timeline?.hasGap && <p className="runtime-assignments-warning">History has a gap. Values from before recovery may be unavailable.</p>}
            </div>
        </div>
    </aside>;
}
