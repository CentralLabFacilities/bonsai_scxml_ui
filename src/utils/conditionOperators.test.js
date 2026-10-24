import { test } from "node:test";
import assert from "node:assert/strict";
import {
    allowedConditionOperator,
    isEqualityOnlyConditionType,
    toEditorConditionOperator,
    toScxmlConditionOperator,
} from "./conditionOperators.js";
import { prepareLiveTransitionCommit } from "./transitionLiveCommit.js";
import {
    deserializeScxmlConditionForEditor,
    serializeEditorConditionForScxml,
} from "./valueTypes.js";

test("String and Boolean conditions accept only equality operators", () => {
    for (const type of ["String", "Boolean"]) {
        assert.equal(isEqualityOnlyConditionType(type), true);
        for (const op of ["<", "<=", ">", ">=", "lt", "le", "gt", "ge"]) {
            assert.equal(allowedConditionOperator(type, op), "==");
        }
        assert.equal(allowedConditionOperator(type, "=="), "==");
        assert.equal(allowedConditionOperator(type, "!="), "!=");
    }
    assert.equal(allowedConditionOperator("Integer", "<="), "<=");
    assert.equal(allowedConditionOperator("Double", "gt"), ">");
});

test("numeric comparison operators serialize in JEXL word form", () => {
    const cases = [
        [">", "gt"], [">=", "ge"], ["<", "lt"], ["<=", "le"],
        ["==", "=="], ["!=", "!="],
    ];
    for (const [symbol, word] of cases) {
        assert.equal(toScxmlConditionOperator(symbol), word);
        assert.equal(serializeEditorConditionForScxml(`count ${symbol} 3`), `count ${word} 3`);
        assert.equal(deserializeScxmlConditionForEditor(`count ${word} 3`), `count ${symbol} 3`);
        assert.equal(toEditorConditionOperator(word), symbol);
    }
});

test("SCXML imports with word operators remain editable and roundtrip without XML entities", () => {
    for (const raw of ["count lt 2", "count le 2", "count gt 2", "count ge 2"]) {
        const restored = deserializeScxmlConditionForEditor(raw);
        assert.equal(serializeEditorConditionForScxml(restored), raw);
    }
    assert.equal(serializeEditorConditionForScxml("name == 'Alice'"), "name == 'Alice'");
    assert.equal(serializeEditorConditionForScxml("temperature >= @threshold"), "temperature ge threshold");
    assert.equal(serializeEditorConditionForScxml("ready"), "ready");
});

test("live condition commit never publishes relational comparisons on string variables", () => {
    const draft = [{
        transitionId: "t1", event: "done", target: "End", conditionEnabled: true,
        conditionVariable: "name", conditionOperator: ">=", conditionValue: "'Alice'", assignments: [],
    }];
    const result = prepareLiveTransitionCommit({
        draft, committed: [], variables: [{ id: "name", expr: "'Bob'" }],
        activeId: "t1", kind: "condition",
    });
    assert.equal(result[0].conditionOperator, "==");
    assert.equal(serializeEditorConditionForScxml(`${result[0].conditionVariable} ${result[0].conditionOperator} ${result[0].conditionValue}`), "name == 'Alice'");
});
