/**
 * The editor keeps stable React Flow node ids separate from SCXML state ids.
 * The latter are exported from fullSkillName (or label/id for containers).
 * SCXML transition targets resolve to these names, so editable names must be
 * unique across the entire document, including nested compounds and lanes.
 */
const text = (value) => String(value ?? "").trim();

export const getExportedStateName = (node) =>
    text(node?.data?.fullSkillName) || text(node?.data?.label) || text(node?.id);

export const isEditorOnlyInstanceName = (node) => {
    if (node?.type === "compound" || node?.type === "parallel" || node?.type === "submachine") return false;
    const skill = text(node?.data?.fullSkillName).split("#")[0].split(".").pop().toLowerCase();
    return ["nop", "fatal", "end"].includes(skill);
};

export const proposedExportedStateName = (node, requestedName) => {
    const next = text(requestedName);
    if (["compound", "parallel", "submachine"].includes(node?.type)) {
        return next || text(node.id);
    }
    const base = text(node?.data?.fullSkillName).split("#")[0] || text(node?.data?.label);
    return next ? `${base}#${next}` : base;
};

export function validateStateRename(nodes, nodeId, requestedName) {
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!node) return "State not found.";
    if (node.data?.isSkillClone || node.data?.isStateClone) return "References cannot be renamed.";

    const editorOnly = isEditorOnlyInstanceName(node);
    const proposed = editorOnly
        ? text(requestedName)
        : proposedExportedStateName(node, requestedName);
    // End/Nop/Fatal instance suffixes are optional editor metadata, not
    // SCXML identities. Clearing the suffix is therefore always allowed.
    if (editorOnly && !proposed) return null;
    if (!proposed) return "A state must have a name.";

    const collision = nodes.some((other) => {
        if (other.id === nodeId || other.type === "slot" ||
            other.data?.isSkillClone || other.data?.isStateClone) return false;
        if (editorOnly) {
            return isEditorOnlyInstanceName(other) &&
                text(other.data?.fullSkillName).split("#")[0] ===
                    text(node.data?.fullSkillName).split("#")[0] &&
                proposed === text(other.data?.editorInstanceId);
        }
        return getExportedStateName(other) === proposed;
    });
    return collision ? `The state name "${proposed}" is already in use.` : null;
}
