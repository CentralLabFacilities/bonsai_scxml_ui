import { getVariableType, normalizeValueType } from "./valueTypes.js";
import { deserializeScxmlAssignmentForEditor } from "./valueTypes.js";

const hasValue = (value) =>
    value !== undefined && value !== null && String(value).trim() !== "";

export const getConfiguredAssignments = (assignments) =>
    (Array.isArray(assignments) ? assignments : []).filter(
        (assignment) => hasValue(assignment?.location) && hasValue(assignment?.expr)
    );

export const parseStateAssignments = (stateElement, actionName) =>
    Array.from(stateElement?.children || [])
        .filter((child) => child.localName === actionName)
        .flatMap((actionElement) =>
            Array.from(actionElement.children)
                .filter((child) => child.localName === "assign")
                .map((assignElement) => ({
                    location: assignElement.getAttribute("location")?.trim() || "",
                    expr: deserializeScxmlAssignmentForEditor(
                        assignElement.getAttribute("expr")?.trim() || ""
                    ),
                }))
        );

/** Destination IDs are resolved in the writable scope first. For a sub-SM,
 * these are its child-local variables, NOT the parent expression variables. */
export function findActionAssignmentTarget(locationId, writableLocations = []) {
    const id = String(locationId || "");
    return (writableLocations || []).find((entry) => entry?.id === id) || null;
}

/** Prefer explicit data-model types but also show inferred literal types. */
export function getActionLocationType(location) {
    if (!location) return null;
    const declared = normalizeValueType(location.valueType || location.type);
    if (declared) return declared;
    const literal = String(location.expr ?? location.value ?? "").trim();
    return literal ? getVariableType(location) : null;
}

/** Human-readable content for the node action badge hover tooltip. */
export function formatStateActionTooltip(assignments, label) {
    const configured = getConfiguredAssignments(assignments);
    const heading = String(label || "State action");
    return [
        `${heading} (${configured.length})`,
        ...configured.map((assignment) => `${assignment.location} = ${assignment.expr}`),
    ].join("\n");
}
