import { isInternalRuntimeName } from "./runtimeEventFrames.js";

/** Read-only runtime values. Populate declared variables before applying observed writes.
 * The engine does not publish the initial value for every variable: in that case
 * the SCXML initializer is the only available value, never an invented event.
 */
export function getRuntimeVariableValues(declarations = [], observed = {}) {
    const merged = new Map();
    for (const variable of declarations || []) {
        const name = String(variable?.id || "").trim();
        if (!name || isInternalRuntimeName(name)) continue;
        merged.set(name, {
            name,
            value: String(variable?.expr ?? variable?.value ?? "Not initialized"),
            dataType: variable?.type || variable?.valueType || "",
            initial: true,
            scope: name.startsWith("_") ? "global" : "local",
        });
    }
    for (const [name, value] of Object.entries(observed || {})) {
        if (isInternalRuntimeName(name)) continue;
        const declared = merged.get(name) || { name };
        // The editor's global/local convention is the source of truth. A
        // runtime snapshot may call the entire datamodel "global" even when
        // its entries are declared local; a later assignment must not move them.
        merged.set(name, { ...declared, ...value, name, initial: false,
            scope: name.startsWith("_") ? "global" : "local" });
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
