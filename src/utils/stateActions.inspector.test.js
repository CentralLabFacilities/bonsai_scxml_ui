import assert from "node:assert/strict";
import test from "node:test";
import { getAvailableActionLocations } from "../components/inspector/selectors.js";
import {
    findActionAssignmentTarget,
    formatStateActionTooltip,
    getActionLocationType,
} from "./stateActions.js";

test("skill OnEntry/OnExit destinations exclude skill API parameters", () => {
    const workflow = [
        { id: "_global", expr: "42", type: "Integer" },
        { id: "myLocal", expr: "'hello'", type: "String" },
        { id: "#_STATE_PREFIX", expr: "'x'" },
        { id: "#_SLOTS", expr: "'slot'" },
    ];
    const skillParams = [
        { key: "_skillOnly", expr: "1", type: "Integer" },
        { key: "mySkillOnly", expr: "true", type: "Boolean" },
    ];
    // Old callers passed skill params as a second argument and the previous
    // selector appended them. They must never enter the writable list.
    const writable = getAvailableActionLocations(workflow, skillParams, false);
    assert.deepEqual(writable.map(({ id }) => id), ["_global", "myLocal"]);
    assert.equal(findActionAssignmentTarget("_skillOnly", writable), null);
    assert.equal(getActionLocationType(writable[0]), "Integer");
    assert.equal(getActionLocationType(writable[1]), "String");
});

test("sub-SM destinations remain child-local and their type wins on parent-name collisions", () => {
    const childLocal = [
        { id: "target", expr: "0", type: "Integer" },
        { id: "childOnly", expr: "true" },
    ];
    const parentExpressions = [
        { id: "target", expr: "'string'", type: "String" },
        { id: "parentOnly", expr: "2.5", type: "Double" },
    ];
    const writable = getAvailableActionLocations(childLocal);
    assert.deepEqual(writable.map(({ id }) => id), ["target", "childOnly"]);
    assert.equal(findActionAssignmentTarget("target", writable, parentExpressions), childLocal[0]);
    assert.equal(findActionAssignmentTarget("parentOnly", writable, parentExpressions), null);
    assert.equal(getActionLocationType(writable[0]), "Integer");
    assert.equal(getActionLocationType(writable[1]), "Boolean");
});

test("type badges infer missing declared types and do not invent types for blanks", () => {
    assert.equal(getActionLocationType({ id: "a", expr: "3.5" }), "Double");
    assert.equal(getActionLocationType({ id: "a", expr: "NaN" }), "Double");
    assert.equal(getActionLocationType({ id: "a", expr: "'hi'" }), "String");
    assert.equal(getActionLocationType({ id: "a", expr: "" }), null);
});

test("node badge hover shows every committed OnEntry/OnExit assignment", () => {
    const assignments = [
        { location: "_counter", expr: "@_counter + 1" },
        { location: "name", expr: "'@literal'" },
        { location: "", expr: "draft" },
        { location: "ignored", expr: "" },
    ];
    assert.equal(formatStateActionTooltip(assignments, "OnEntry assignments"),
        "OnEntry assignments (2)\n_counter = @_counter + 1\nname = '@literal'");
});
