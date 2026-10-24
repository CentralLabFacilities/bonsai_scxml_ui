import { validateAssignmentExpression } from "../../utils/assignmentExpressions.js";
import { getVariableType, isValueTypeCompatible, normalizeValueType } from "../../utils/valueTypes.js";

export function getVariableReferenceContext(value, caretPosition) {
    const text = String(value || "");
    const caret = Number.isInteger(caretPosition) ? caretPosition : text.length;
    // A reference marker inside a quoted literal is plain text and must not
    // trigger autocomplete or replace part of the user's string.
    let quote = null;
    for (let i = 0; i < caret; i += 1) {
        if (quote && text[i] === "\\") {
            i += 1;
        } else if (text[i] === quote) {
            quote = null;
        } else if (!quote && (text[i] === "'" || text[i] === '"')) {
            quote = text[i];
        }
    }
    if (quote) return null;

    const match = text.slice(0, caret).match(/@([A-Za-z0-9_:#.-]*)$/);

    if (!match) return null;

    return { start: match.index, end: caret, query: match[1] || "" };
}

export function getMatchingExpressionVariables(
    value,
    caretPosition,
    variables,
    { excludeStatePrefix = true, targetVariable = null, requireCompatibleType = false } = {}
) {
    const context = getVariableReferenceContext(value, caretPosition);
    if (!context) return { context: null, matches: [] };

    // Assignment editors must know the destination before offering reference
    // candidates. Otherwise the list would contain incompatible variables.
    if (requireCompatibleType && !targetVariable) return { context, matches: [] };
    const targetType = targetVariable &&
        (normalizeValueType(getVariableType(targetVariable)) || getVariableType(targetVariable));
    if (requireCompatibleType && !targetType) return { context, matches: [] };

    const query = context.query.toLowerCase();
    const candidates = (Array.isArray(variables) ? variables : [])
        .filter((variable) =>
            variable?.id &&
            (!excludeStatePrefix || String(variable.id).trim() !== "#_STATE_PREFIX") &&
            String(variable.id).toLowerCase().includes(query)
        )
        .sort((a, b) => {
            const aId = String(a.id).toLowerCase();
            const bId = String(b.id).toLowerCase();
            const aStarts = aId.startsWith(query) ? 0 : 1;
            const bStarts = bId.startsWith(query) ? 0 : 1;
            return aStarts - bStarts || aId.localeCompare(bId);
        });

    const singleReference = /^@[A-Za-z0-9_:#.\-]*$/.test(String(value || "").trim());
    const matches = [];
    for (const variable of candidates) {
        if (targetType) {
            if (singleReference) {
                if (!isValueTypeCompatible(getVariableType(variable), targetType)) continue;
            } else {
                // A Boolean comparison can contain numeric operands. Validate
                // the whole expression rather than comparing each operand to
                // the assignment destination's type.
                const insertion = insertExpressionVariable(value, caretPosition, variable.id);
                if (!insertion || !validateAssignmentExpression(
                    insertion.value, targetVariable, variables
                ).valid) continue;
            }
        }
        matches.push(variable);
        if (matches.length >= 8) break;
    }

    return { context, matches };
}

export function insertExpressionVariable(value, caretPosition, variableId) {
    if (!variableId) return null;

    const context = getVariableReferenceContext(value, caretPosition);
    if (!context) return null;

    const text = String(value || "");
    const replacement = `@${variableId}`;
    return {
        value: text.slice(0, context.start) + replacement + text.slice(context.end),
        caretPosition: context.start + replacement.length,
    };
}

export function getExpressionAutocompleteAction(key, isOpen, matchCount, activeIndex) {
    if (!isOpen || matchCount === 0) return null;

    if (key === "ArrowDown") {
        return { type: "navigate", index: activeIndex < matchCount - 1 ? activeIndex + 1 : 0 };
    }
    if (key === "ArrowUp") {
        return { type: "navigate", index: activeIndex > 0 ? activeIndex - 1 : matchCount - 1 };
    }
    if (key === "Enter" || key === "Tab") {
        return {
            type: "select",
            index: activeIndex >= 0 && activeIndex < matchCount ? activeIndex : 0,
        };
    }
    if (key === "Escape") return { type: "close" };

    return null;
}
