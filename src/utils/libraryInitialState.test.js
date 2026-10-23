import assert from "node:assert/strict";
import test from "node:test";
import { appendLibraryNodeWithInitial } from "./libraryInitialState.js";

const node = (id, parentId = null, isInitial = false, type = "custom") => ({
    id, parentId, type, data: { isInitial, label: id }, position: { x: 0, y: 0 },
});
const initialIds = (nodes, parentId = null) => nodes.filter((n) =>
    (n.parentId || null) === parentId && n.data?.isInitial && n.type !== "parallelLane"
).map((n) => n.id);

test("first library state becomes the only root initial", () => {
    const added = appendLibraryNodeWithInitial([], node("one"));
    assert.deepEqual(initialIds(added), ["one"]);
});

test("rapid subsequent root drops never create multiple initials even with stale incoming flags", () => {
    const first = appendLibraryNodeWithInitial([], node("one", null, true));
    const second = appendLibraryNodeWithInitial(first, node("two", null, true));
    const third = appendLibraryNodeWithInitial(second, node("three", null, true));
    assert.deepEqual(initialIds(third), ["one"]);
    assert.equal(third.find((n) => n.id === "three").data.isInitial, false);
});

test("repair a legacy duplicate flag without selecting the newly dropped skill", () => {
    const result = appendLibraryNodeWithInitial([
        node("first", null, true), node("second", null, true),
    ], node("third", null, true));
    assert.deepEqual(initialIds(result), ["first"]);
});

test("existing explicit initial remains initial if it isn't the first sibling", () => {
    const result = appendLibraryNodeWithInitial([
        node("first"), node("chosen", null, true),
    ], node("new", null, true));
    assert.deepEqual(initialIds(result), ["chosen"]);
});

test("first inserted child selects the compound's initial; subsequent children do not override", () => {
    const compound = node("c", null, false, "compound");
    const first = appendLibraryNodeWithInitial([compound], node("a", "c", true));
    const second = appendLibraryNodeWithInitial(first, node("b", "c", true));
    assert.equal(second[0].data.initialChildId, "a");
    assert.deepEqual(initialIds(second, "c"), ["a"]);
});

test("two parallel lanes each retain their own initial child", () => {
    const lanes = [node("lane-1", "parallel", false, "parallelLane"), node("lane-2", "parallel", false, "parallelLane")];
    const a = appendLibraryNodeWithInitial(lanes, node("a", "lane-1"));
    const b = appendLibraryNodeWithInitial(a, node("b", "lane-2"));
    const c = appendLibraryNodeWithInitial(b, node("c", "lane-1", true));
    assert.deepEqual(initialIds(c, "lane-1"), ["a"]);
    assert.deepEqual(initialIds(c, "lane-2"), ["b"]);
    assert.equal(c[0].data.initialChildId, "a");
    assert.equal(c[1].data.initialChildId, "b");
});

test("library insertion repairs a missing initial by keeping the first existing sibling", () => {
    const result = appendLibraryNodeWithInitial([node("first"), node("second")], node("third"));
    assert.deepEqual(initialIds(result), ["first"]);
});
