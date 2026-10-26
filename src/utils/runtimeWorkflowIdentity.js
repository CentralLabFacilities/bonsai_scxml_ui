import { getExportFullSkillName } from "./editorScxml.js";

const text = (value) => String(value ?? "").trim();
// The engine sometimes reports just the skill's short name while the editor
// stores a fully qualified class name. Preserve its invocation suffix (#...).
export const shortRuntimeStateId = (value) => {
    const name = text(value);
    const hash = name.indexOf("#");
    const base = hash < 0 ? name : name.slice(0, hash);
    return base.slice(base.lastIndexOf(".") + 1) + (hash < 0 ? "" : name.slice(hash));
};

export function initialWorkflowStateIds(workflow) {
    if (!workflow) return [];
    const roots = (workflow.nodes || []).filter((node) => !node.parentId &&
        !node.data?.isSkillClone && !node.data?.isStateClone && node.type !== "parallelLane");
    const initial = roots.find((node) => node.data?.isInitial) || roots[0];
    if (!initial) return [];
    return [...new Set([
        getExportFullSkillName(initial), initial.data?.scxmlStateId,
        initial.data?.fullSkillName, initial.data?.label,
    ].map(text).filter(Boolean))];
}

/** No workflow ID exists in the protocol. This is only a compatibility check. */
export function matchesLoadedInitial(workflow, initial) {
    const received = text(initial);
    if (!received) return false;
    const expected = initialWorkflowStateIds(workflow);
    return expected.includes(received) || expected.some((id) =>
        shortRuntimeStateId(id) === shortRuntimeStateId(received));
}
