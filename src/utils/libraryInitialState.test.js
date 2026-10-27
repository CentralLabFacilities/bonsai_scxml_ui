import assert from "node:assert/strict";
import test from "node:test";
import { appendLibraryNodeWithInitial, ensureUniqueLibraryNodeId, availableLibrarySkillName } from "./libraryInitialState.js";

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

test('two asynchronous skill inspections with the same tentative name are rebased on committed nodes', () => {
    const first = { ...node('a'), data: { fullSkillName: 'Wait#1', label: 'Wait' } };
    const second = { ...node('b'), data: { fullSkillName: 'Wait#1', label: 'Wait', isInitial: true } };
    const after = appendLibraryNodeWithInitial(appendLibraryNodeWithInitial([], first), second);
    assert.deepEqual(after.map(n => n.data.fullSkillName), ['Wait#1', 'Wait#2']);
    assert.deepEqual(initialIds(after), ['a']);
});

test('consecutive End/Fatal inserts keep distinct shared-state instance identities', () => {
    const finalState = (id) => ({ ...node(id), data: {
        label: 'End', isFinal: true, fullSkillName: 'End', scxmlStateId: 'End',
        editorInstanceId: '1',
    }});
    const after = appendLibraryNodeWithInitial(
        appendLibraryNodeWithInitial([], finalState('a')), finalState('b'));
    assert.deepEqual(after.map(n => n.data.editorInstanceId), ['1', '2']);
    assert.deepEqual(initialIds(after), ['a']);
});

test("two imported nodes cannot reuse one React Flow id", () => {
    const first = node("skill-node-old");
    let attempts = 0;
    const second = ensureUniqueLibraryNodeId([first], node("skill-node-old"), () =>
        ++attempts === 1 ? "skill-node-old" : "skill-node-new");
    assert.equal(second.id, "skill-node-new");
    const result = appendLibraryNodeWithInitial(appendLibraryNodeWithInitial([], first), second);
    assert.equal(new Set(result.map((item) => item.id)).size, 2);
    assert.deepEqual(initialIds(result), ["skill-node-old"]);
});

test("rapid root and compound inserts have globally distinct skill ids and single scoped initials", () => {
    const make = (id, parentId = null) => ({...node(id, parentId, true),
        data: {label: "Wait", fullSkillName: "example.Wait#1", isInitial: true}});
    let result = appendLibraryNodeWithInitial([], make("root-a"));
    result = appendLibraryNodeWithInitial(result, make("root-b"));
    result = appendLibraryNodeWithInitial(result, node("compound", null, false, "compound"));
    result = appendLibraryNodeWithInitial(result, make("nested-a", "compound"));
    result = appendLibraryNodeWithInitial(result, make("nested-b", "compound"));
    assert.equal(new Set(result.filter((x) => x.type === "custom").map((x) => x.data.fullSkillName)).size, 4);
    assert.deepEqual(initialIds(result), ["root-a"]);
    assert.deepEqual(initialIds(result, "compound"), ["nested-a"]);
    assert.equal(result.find((x) => x.id === "compound").data.initialChildId, "nested-a");
});

test("asynchronous skill inspection allocates from the latest committed names", () => {
    const existing = [{ ...node("a"), data: { fullSkillName: "example.Wait#1" } }];
    assert.equal(availableLibrarySkillName(existing, "example.Wait"), "example.Wait#2");
    assert.equal(availableLibrarySkillName([...existing, {
        ...node("b"), data: { fullSkillName: "example.Wait#2" },
    }], "example.Wait"), "example.Wait#3");
});
