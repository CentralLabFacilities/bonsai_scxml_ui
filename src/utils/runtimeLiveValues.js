import { getExportFullSkillName } from "./editorScxml.js";

const text = (value) => String(value ?? "").trim();
const shortState = (value) => {
    const full = text(value);
    const hash = full.indexOf("#");
    const base = hash < 0 ? full : full.slice(0, hash);
    return base.slice(base.lastIndexOf(".") + 1) + (hash < 0 ? "" : full.slice(hash));
};
const slotPath = (value) => `/${text(value).replace(/^\/+/, "")}`;

const skillNodes = (nodes) => nodes.filter((node) =>
    ["custom", "submachine"].includes(node.type) && !node.data?.isSkillClone && !node.data?.isStateClone);
const stateIdentity = (node) => text(getExportFullSkillName(node) || node.data?.fullSkillName || node.data?.label);
function findUniqueSkill(nodes, state) {
    const eligible = skillNodes(nodes);
    // Prefer complete SCXML IDs: a short-name match is safe only when unique.
    const exact = eligible.filter((node) => stateIdentity(node) === state || text(node.data?.scxmlStateId) === state);
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    const fallback = eligible.filter((node) => shortState(stateIdentity(node)) === shortState(state));
    return fallback.length === 1 ? fallback[0] : null;
}

/** Only unambiguous loaded skill states may supply manual exit events. */
export function getManualRuntimeEvents(workflow, activeStates = []) {
    const nodes = workflow?.nodes || [];
    const results = [];
    for (const state of activeStates) {
        const node = findUniqueSkill(nodes, state);
        if (!node) continue;
        const base = text(state).split("#")[0].split(".").at(-1);
        for (const event of node.data?.events || []) {
            const name = text(event?.id);
            if (!name || name === "*") continue; // Wildcard matches events; it is not an emitted exit token.
            const value = name.includes(".") ? name : `${base}.${name}`;
            if (!results.some((item) => item.value === value)) results.push({ value, label: value });
        }
        // Fatal is a built-in event for ordinary skills, even if not in data.events.
        if (node.type === "custom" && !node.data?.isFinal && !node.data?.isBehaviorExit) {
            const value = `${base}.fatal`;
            if (!results.some((item) => item.value === value)) results.push({ value, label: value });
        }
    }
    return results;
}

/** Add ephemeral decorations, never mutate persisted workflow node data. */
export function decorateLiveRuntimeNodes(nodes, frame) {
    if (!frame) return nodes;
    const slots = frame.slots || {};
    const active = new Set(frame.activeStates || []);
    if (frame.kind === "state" && frame.state) active.add(frame.state);
    const parametersByNode = new Map();
    for (const entry of Object.values(frame.parameters || {})) {
        if (!active.has(entry.state)) continue;
        const node = findUniqueSkill(nodes, entry.state);
        if (!node) continue;
        const values = parametersByNode.get(node.id) || {};
        values[entry.name] = { value: entry.value, timestamp: entry.timestamp };
        parametersByNode.set(node.id, values);
    }
    return nodes.map((node) => {
        if (node.type === "slot") {
            const path = slotPath(node.data?.path || node.data?.label);
            const item = slots[path];
            if (!item) return node;
            return { ...node, data: { ...node.data, runtimeSlotValueMeta: item } };
        }
        if (!["custom", "submachine"].includes(node.type)) return node;
        const runtimeParameterValues = parametersByNode.get(node.id);
        if (!runtimeParameterValues) return node;
        return { ...node, data: { ...node.data, runtimeParameterValues } };
    });
}
