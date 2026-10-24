import { validateAssignmentValue, validateConditionValue } from "./valueValidation.js";
import { getVariableType } from "./valueTypes.js";
import { allowedConditionOperator } from "./conditionOperators.js";

/**
 * Convert an editor draft into the currently publishable graph. Target changes
 * and unrelated edits must never publish incomplete expressions, or erase
 * already committed expressions while another field is being edited.
 *
 * Only the explicitly confirmed condition/assignment is newly committed.
 * Existing records keep their stable IDs so a subsequent commit edits the same
 * SCXML transition rather than creating a duplicate.
 */
export function prepareLiveTransitionCommit({
    draft, committed, variables, activeId, kind, assignmentId = null,
}) {
    const savedById = new Map((committed || []).map(item => [item.transitionId, item]));
    const variableById = new Map((variables || []).map(variable => [variable.id, variable]));
    return (draft || []).filter(item => Boolean(item.target)).map(item => {
        const saved = savedById.get(item.transitionId);
        const editingActive = item.transitionId === activeId;
        // The first target selection publishes a new transition. Promote any
        // *complete* condition or assignments prepared before the target was
        // chosen. For existing transitions, retain explicit Enter-to-commit.
        const firstTargetCommit = editingActive && kind === "target" && !saved;
        const confirmCondition = editingActive && (kind === "condition" || firstTargetCommit);
        const selectedCondition = confirmCondition ? item : saved;
        const conditionVar = variableById.get(selectedCondition?.conditionVariable);
        const validCondition = !selectedCondition?.conditionEnabled || Boolean(conditionVar &&
            validateConditionValue(selectedCondition.conditionValue, conditionVar, variables, { allowEmpty: false }).valid);
        const condition = validCondition ? selectedCondition : saved;

        const savedAssignments = saved?.assignments || [];
        const savedAssignmentById = new Map(savedAssignments.map(assignment => [assignment.assignmentId, assignment]));
        const editingAssignment = editingActive && (kind === "assignment" || firstTargetCommit);
        const deletingAssignment = editingActive && kind === "assignment-delete";
        const assignments = (editingAssignment || deletingAssignment)
            ? (item.assignments || []).flatMap(assignment => {
                const original = savedAssignmentById.get(assignment.assignmentId);
                if (!editingAssignment || (!firstTargetCommit && assignment.assignmentId !== assignmentId)) {
                    return original ? [original] : [];
                }
                const variable = variableById.get(assignment.location);
                const valid = Boolean(variable && validateAssignmentValue(assignment.expr, variable, variables, { allowEmpty: false }).valid);
                return valid ? [assignment] : original ? [original] : [];
            })
            : savedAssignments;
        return {
            ...item,
            conditionEnabled: Boolean(condition?.conditionEnabled),
            conditionVariable: condition?.conditionVariable || item.conditionVariable,
            conditionOperator: confirmCondition && validCondition
                ? allowedConditionOperator(getVariableType(conditionVar), condition?.conditionOperator || "==")
                : (condition?.conditionOperator || "=="),
            conditionValue: condition?.conditionValue || "",
            assignments,
        };
    });
}
