import assert from "node:assert/strict";
import test from "node:test";
import { appendLibraryNodeWithInitial, ensureUniqueLibraryNodeId, availableLibrarySkillName, preserveInitialsAfterInsertion } from "./libraryInitialState.js";

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


test("incremental Rust acknowledgement cannot restore a second root initial", () => {
    const before = appendLibraryNodeWithInitial(
        appendLibraryNodeWithInitial([], { ...node("first"), data: { fullSkillName: "example.Wait#1", isInitial: true } }),
        { ...node("second"), data: { fullSkillName: "example.Wait#2", isInitial: true } }
    );
    // Rust may return a partial insertion patch with the new state initial,
    // without clearing the previous root initial in the same patch.
    const patched = before.map((n) => n.id === "second"
        ? { ...n, data: { ...n.data, isInitial: true } } : n);
    const normalized = preserveInitialsAfterInsertion(before, patched, ["second"]);
    assert.deepEqual(initialIds(normalized), ["first"]);
    assert.equal(normalized.find((n) => n.id === "second").data.fullSkillName, "example.Wait#2");
});

test("insertion acknowledgement keeps an explicit initial in a nested scope", () => {
    const before = [node("compound", null, false, "compound"),
        node("first", "compound", false), node("chosen", "compound", true),
        node("inserted", "compound", false)];
    before[0].data.initialChildId = "chosen";
    const patched = before.map((n) => n.id === "inserted"
        ? { ...n, data: { ...n.data, isInitial: true } } : n);
    const normalized = preserveInitialsAfterInsertion(before, patched, ["inserted"]);
    assert.deepEqual(initialIds(normalized, "compound"), ["chosen"]);
    assert.equal(normalized[0].data.initialChildId, "chosen");
});


test("repeated sub-state-machine drops get unique SCXML names even across lanes", () => {
    const behavior = (id, parentId) => ({ ...node(id, parentId, false, "submachine"),
        data: { label: "Search", fullSkillName: "Search", src: "${BEHAVIORS}/Search.xml" } });
    const first = appendLibraryNodeWithInitial([], behavior("child1", "laneA"));
    const second = appendLibraryNodeWithInitial(first, behavior("child2", "laneB"));
    const third = appendLibraryNodeWithInitial(second, behavior("child3", "laneA"));
    assert.deepEqual(third.map((n) => n.data.fullSkillName), ["Search", "Search#2", "Search#3"]);
    assert.deepEqual(third.map((n) => n.data.label), ["Search", "Search#2", "Search#3"]);
    assert.ok(third.every((n) => n.data.src === "${BEHAVIORS}/Search.xml"));
});

test("a sub-state-machine also avoids collisions with an existing compound", () => {
    const compound = { ...node("compound", null, false, "compound"),
        data: { label: "Search", fullSkillName: "Search" } };
    const incoming = { ...node("sub", null, false, "submachine"),
        data: { label: "Search", fullSkillName: "Search", src: "Search.xml" } };
    const result = appendLibraryNodeWithInitial([compound], incoming);
    assert.equal(result[1].data.fullSkillName, "Search#2");
});
