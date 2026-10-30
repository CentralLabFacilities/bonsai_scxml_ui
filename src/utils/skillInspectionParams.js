import { getReferenceName, normalizeValueType } from "./valueTypes.js";

const SCALAR_LITERAL = /^(?:true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/i;

const unquote = (value) => {
  const text = String(value ?? "").trim();
  if (text.length < 2 || !["'", '"'].includes(text[0]) || text.at(-1) !== text[0]) {
    return null;
  }
  // Only decode the escapes that the editor's quoted-string writer creates.
  return text.slice(1, -1).replace(/\\(['"\\])/g, "$1");
};

function resolveVariableLiteral(name, variablesById, visited) {
  if (visited.has(name)) return null;
  const variable = variablesById.get(name);
  if (!variable) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(name);
  const expression = String(variable.expr ?? variable.value ?? "").trim();
  if (!expression) return null;

  const nestedReference = getReferenceName(expression);
  if (nestedReference) return resolveVariableLiteral(nestedReference, variablesById, nextVisited);

  const quoted = unquote(expression);
  if (quoted !== null) return { value: quoted, type: "String" };
  if (/^(true|false)$/i.test(expression)) return { value: expression.toLowerCase(), type: "Boolean" };
  if (SCALAR_LITERAL.test(expression)) {
    return { value: expression, type: /^[+-]?\d+$/.test(expression) ? "Integer" : "Double" };
  }
  // Bare expressions such as `_other`, `counter + 1`, or a function call are
  // evaluated by SCXML at runtime. The inspection endpoint cannot evaluate them.
  return null;
}

/**
 * Prepare concrete values for Bonsai's skill-inspection API without modifying
 * the expressions saved in the SCXML editor.
 *
 * Only resolve variables with literal datamodel definitions. Returning an
 * unresolved reference is safer than treating @name as a string, passing an
 * invalid Integer/Boolean to the Java configurator, or inventing a placeholder.
 */
export function resolveSkillInspectionParams(parameters = {}, variables = [], parameterDefinitions = []) {
  const variablesById = new Map();
  for (const variable of variables || []) {
    if (variable?.id && !variablesById.has(variable.id)) variablesById.set(variable.id, variable);
  }
  const definitionsByKey = new Map(
    (parameterDefinitions || []).filter((param) => param?.key).map((param) => [param.key, param]),
  );
  const params = {};
  const unresolved = [];
  for (const [key, rawValue] of Object.entries(parameters || {})) {
    const referenceName = getReferenceName(rawValue);
    if (!referenceName) {
      params[key] = rawValue;
      continue;
    }
    const literal = resolveVariableLiteral(referenceName, variablesById, new Set());
    const expected = normalizeValueType(definitionsByKey.get(key)?.type);
    if (!literal || (expected && expected !== literal.type && !(expected === "Double" && literal.type === "Integer"))) {
      unresolved.push(key);
      continue;
    }
    params[key] = literal.value;
  }
  return { params, unresolved };
}
