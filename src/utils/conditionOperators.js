/** JEXL supports written relational operators; keep symbols for the editor. */
const TO_WRITTEN = Object.freeze({ ">": "gt", ">=": "ge", "<": "lt", "<=": "le" });
const TO_SYMBOL = Object.freeze({ gt: ">", ge: ">=", lt: "<", le: "<=" });

export const toScxmlConditionOperator = (operator) => TO_WRITTEN[operator] || operator;
export const toEditorConditionOperator = (operator) => TO_SYMBOL[operator] || operator;
export const isEqualityOnlyConditionType = (type) => type === "String" || type === "Boolean";
export function allowedConditionOperator(type, operator) {
    const symbol = toEditorConditionOperator(operator);
    return isEqualityOnlyConditionType(type) && symbol !== "==" && symbol !== "!=" ? "==" : symbol;
}

/** Match a single comparison, preserving unstructured/legacy JEXL expressions. */
export const COMPARISON_PATTERN = /^(@?[^\s]+)\s*(==|!=|>=|<=|>|<|\bge\b|\ble\b|\bgt\b|\blt\b)\s*(.+)$/;
