import assert from "node:assert/strict";
import test from "node:test";
import { matchImportedSlotDeclaration } from "./scxmlSlotMatching.js";

const declaration = (state, key, xpath) => ({ state, key, xpath });
const match = (declarations, state, key) =>
    matchImportedSlotDeclaration(declarations, {
        fullSkillName: state,
        baseSkillName: state.split("#")[0],
        slotKey: key,
    })?.xpath ?? "";

test("does not invent a Read mapping from a Write-only declaration (writeB regression)", () => {
    const slots = [
        declaration("exercise.SlotIO#writeA", "Read", "/test/one"),
        declaration("exercise.SlotIO#writeA", "Write", "/test/one"),
        declaration("exercise.SlotIO#writeB", "Write", "/test/two"),
    ];

    assert.equal(match(slots, "exercise.SlotIO#writeA", "Read"), "/test/one");
    assert.equal(match(slots, "exercise.SlotIO#writeA", "Write"), "/test/one");
    assert.equal(match(slots, "exercise.SlotIO#writeB", "Read"), "");
    assert.equal(match(slots, "exercise.SlotIO#writeB", "Write"), "/test/two");
    assert.equal(match(slots, "exercise.SlotIO#readA", "Read"), "");
    assert.equal(match(slots, "exercise.SlotIO#readB", "Read"), "");
});

test("never maps an unrelated lone key just because it is the sole state declaration", () => {
    const slots = [declaration("example.Skill#1", "StringSlot", "/legacy")];
    assert.equal(match(slots, "example.Skill#1", "Read"), "");
    assert.equal(match(slots, "example.Skill#1", "Write"), "");
    assert.equal(match(slots, "example.Skill#1", "StringSlot"), "/legacy");
});

test("ambiguous same-state/same-key declarations cannot be assigned by order", () => {
    const slots = [
        declaration("exercise.SlotIO#1", "StringSlot", "/first"),
        declaration("exercise.SlotIO#1", "StringSlot", "/second"),
    ];
    assert.equal(match(slots, "exercise.SlotIO#1", "StringSlot"), "");
});

test("does not borrow a mapping from another skill instance", () => {
    assert.equal(match([
        declaration("exercise.SlotIO#writeA", "Read", "/one"),
    ], "exercise.SlotIO#writeB", "Read"), "");
});

test("retains explicit base-skill and wildcard matching by exact key", () => {
    assert.equal(match([
        declaration("exercise.SlotIO", "Read", "/shared"),
    ], "exercise.SlotIO#writeA", "Read"), "/shared");
    assert.equal(match([
        declaration("*", "Write", "/global"),
    ], "exercise.SlotIO#writeA", "Write"), "/global");
    assert.equal(match([
        declaration("*", "Write", "/global"),
    ], "exercise.SlotIO#writeA", "Read"), "");
});

test("an explicit state takes precedence over a broad mapping even if its key differs", () => {
    const slots = [
        declaration("exercise.SlotIO#1", "Write", "/specific"),
        declaration("exercise.SlotIO", "Read", "/base"),
    ];
    assert.equal(match(slots, "exercise.SlotIO#1", "Read"), "");
});
