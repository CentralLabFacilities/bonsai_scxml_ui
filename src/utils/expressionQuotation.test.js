import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAssignmentExpressionForScxml } from "./editorScxml.js";
import { normalizeAssignmentExpressionInput, validateAssignmentExpression } from "./assignmentExpressions.js";
import {
    serializeEditorAssignmentForScxml,
    deserializeScxmlAssignmentForEditor,
    serializeEditorConditionForScxml,
    deserializeScxmlConditionForEditor,
} from "./valueTypes.js";
import {
    getVariableReferenceContext,
    getMatchingExpressionVariables,
    insertExpressionVariable,
} from "../components/inputs/expressionAutocomplete.js";

const variables = [
    { id: "count", type: "Integer", expr: "1" },
    { id: "text", type: "String", expr: "'hello'" },
];

test("quoted assignment text is never unwrapped or evaluated by the export paths", () => {
    for (const literal of ["'@count + 1'", '"@count == 2"', "'@count >= 3'", "'contact@example.com'", "'@'", "'a \\' @count'"]) {
        assert.equal(normalizeAssignmentExpressionForScxml(literal), literal);
        assert.equal(serializeEditorAssignmentForScxml(literal), literal);
        assert.equal(deserializeScxmlAssignmentForEditor(literal, variables), literal);
        assert.equal(normalizeAssignmentExpressionInput(literal, variables[1], variables), literal);
        assert.equal(validateAssignmentExpression(literal, variables[1], variables).valid, true);
    }
});

test("unquoted references are still expressions while nested quotes remain literal", () => {
    assert.equal(normalizeAssignmentExpressionForScxml("@count + 1"), "count + 1");
    assert.equal(serializeEditorAssignmentForScxml("@count + 1"), "count + 1");
    assert.equal(serializeEditorAssignmentForScxml("@text == '@count'"), "text == '@count'");
    assert.equal(normalizeAssignmentExpressionForScxml("@text == '@count'"), "text == '@count'");
    assert.equal(validateAssignmentExpression("'@count + 1'", variables[0], variables).valid, false);
});

test("condition import/export keeps quoted @ and comparison symbols intact", () => {
    for (const value of ["'@count < 5'", '"@text == true"', "'@'", "'a \\' > b'"]) {
        assert.equal(serializeEditorConditionForScxml(value), value);
        assert.equal(deserializeScxmlConditionForEditor(value), value);
    }
    assert.equal(serializeEditorConditionForScxml("@count <= 3"), "count le 3");
    assert.equal(serializeEditorConditionForScxml("@count > 3 && '@count'"), "count gt 3 && '@count'");
});

test("autocomplete never interprets @ while the caret is inside quotes", () => {
    for (const value of ["'@count'", '"@count"', "'escaped \\' @count'"]) {
        const caret = value.indexOf('@') + 3;
        assert.equal(getVariableReferenceContext(value, caret), null);
        assert.equal(insertExpressionVariable(value, caret, "count"), null);
        assert.deepEqual(getMatchingExpressionVariables(value, caret, variables).matches, []);
    }
    assert.equal(getVariableReferenceContext("'@text' + @co", 13)?.query, "co");
});
