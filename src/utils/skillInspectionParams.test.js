import test from "node:test";
import assert from "node:assert/strict";
import { resolveSkillInspectionParams } from "./skillInspectionParams.js";

const variables = [
  { id: "_test", expr: "42" },
  { id: "_flag", expr: "true" },
  { id: "_text", expr: "'Hello'" },
  { id: "_alias", expr: "@_test" },
  { id: "_computed", expr: "_test + 1" },
  { id: "_cycleA", expr: "@_cycleB" },
  { id: "_cycleB", expr: "@_cycleA" },
];

test("resolves static datamodel references for Java skill inspection, preserving editor references", () => {
  const editorParameters = { P: "@_test", B: "@_flag", S: "@_text", A: "@_alias" };
  const result = resolveSkillInspectionParams(editorParameters, variables, [
    { key: "P", type: "Integer" },
    { key: "B", type: "Boolean" },
    { key: "S", type: "String" },
    { key: "A", type: "Double" },
  ]);
  assert.deepEqual(result, { params: { P: "42", B: "true", S: "Hello", A: "42" }, unresolved: [] });
  assert.equal(editorParameters.P, "@_test");
});

test("does not invent values for computed, missing, cyclic or incompatible references", () => {
  const result = resolveSkillInspectionParams(
    { P: "@_computed", B: "@_test", X: "@missing", A: "@_cycleA" },
    variables,
    [
      { key: "P", type: "Integer" },
      { key: "B", type: "Boolean" },
      { key: "X", type: "String" },
      { key: "A", type: "String" },
    ],
  );
  assert.deepEqual(result.params, {});
  assert.deepEqual(result.unresolved, ["P", "B", "X", "A"]);
});

test("preserves typed and quoted direct parameters for the existing API normalizer", () => {
  const result = resolveSkillInspectionParams({ A: "'quoted'", B: "false", C: "0" }, variables);
  assert.deepEqual(result, { params: { A: "'quoted'", B: "false", C: "0" }, unresolved: [] });
});
