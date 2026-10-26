import { isInternalRuntimeName } from "./runtimeEventFrames.js";

/** Read-only runtime values. Populate declared variables before applying observed writes.
 * The engine does not publish the initial value for every variable: in that case
 * the SCXML initializer is the only available value, never an invented event.
 */
export function getRuntimeVariableValues(declarations = [], observed = {}) {
    const merged = new Map();
    for (const variable of declarations || []) {
        const name = String(variable?.id || "").trim();
        if (!name || name.startsWith("#") || isInternalRuntimeName(name)) continue;
        const scope = name.startsWith("_") ? "global" : "local";
        merged.set(`${scope}:${name}`, {
            name, scope, value: String(variable?.expr ?? variable?.value ?? "Not initialized"),
            dataType: variable?.type || variable?.valueType || "", initial: true,
        });
    }
    // New protocol carries a dictionary of independently owned scopes. A local
    // `hello` must never overwrite global `hello` or a sibling's local `hello`.
    const scoped = Object.hasOwn(observed || {}, "global") || Object.values(observed || {})
        .some((entry) => entry && typeof entry === "object" && !Object.hasOwn(entry, "value"));
    if (scoped) {
        for (const [owner, values] of Object.entries(observed || {})) {
            for (const [name, value] of Object.entries(values || {})) {
                if (String(name).startsWith("#") || isInternalRuntimeName(name)) continue;
                const scope = String(name).startsWith("_") ? "global" : "local";
                const key = `${owner}:${name}`;
                merged.delete(`local:${name}`);
                merged.delete(`global:${name}`);
                merged.set(key, { ...value, name, scope, owner, initial: false });
            }
        }
    } else {
        for (const [name, value] of Object.entries(observed || {})) {
            if (String(name).startsWith("#") || isInternalRuntimeName(name)) continue;
            const scope = name.startsWith("_") ? "global" : "local";
            merged.set(`${scope}:${name}`, { ...value, name, scope, initial: false });
        }
    }
    return [...merged.values()];
}

/** A parameter belongs to the currently selected state snapshot, not every
 * skill that has previously resolved a parameter during the run.
 */
export function getActiveRuntimeParameters(frame) {
    if (!frame) return [];
    const states = new Set(frame.activeStates || []);
    if (frame.kind === "state" && frame.state) states.add(frame.state);
    return Object.values(frame.parameters || {})
        .filter((entry) => states.has(entry.state) && !isInternalRuntimeName(entry.name))
        .sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
}

/** Extract optional baseline values from /bonsai/snapshot without assuming a
 * single server JSON spelling. Unrelated snapshot metadata is never treated
 * as a variable. Nested local state contexts are flattened by variable name.
 */
export function getRuntimeBaselineValues(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return {};
    const result = {};
    const collect = (entries, scope, depth = 0) => {
        if (!entries || typeof entries !== "object" || depth > 4) return;
        if (Array.isArray(entries)) {
            for (const item of entries) {
                const name = item?.id || item?.name || item?.location;
                if (name) {
                    if (!isInternalRuntimeName(name)) {
                        result[String(name)] = { value: String(item.value ?? item.expr ?? "Unknown"),
                            dataType: item.dataType || item.type || "", scope };
                    }
                } else collect(item, scope, depth + 1);
            }
            return;
        }
        for (const [name, value] of Object.entries(entries)) {
            if (value && typeof value === "object" && !Array.isArray(value)
                && !Object.hasOwn(value, "value") && !Object.hasOwn(value, "expr")) {
                collect(value, scope, depth + 1);
            } else if (typeof value !== "function" && !isInternalRuntimeName(name)) {
                result[name] = { value: String(value?.value ?? value?.expr ?? value ?? "null"),
                    dataType: value?.dataType || value?.type || "", scope };
            }
        }
    };
    const datamodel = snapshot.datamodel || snapshot.dataModel || {};
    for (const [scope, keys] of [
        ["global", ["globalVariables", "globalDataModel", "globalDatamodel", "global"]],
        ["local", ["localVariables", "localDataModel", "localDatamodel", "local"]],
    ]) {
        for (const key of keys) collect(snapshot[key] ?? datamodel[key], scope);
    }
    return result;
}
