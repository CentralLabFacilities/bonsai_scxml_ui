import assert from "node:assert/strict";
import test from "node:test";
import {
    findSharedSlotPartner, updateSharedSlotBinding, getGroupedSkillSlotRequests,
    fillMissingSharedSlotBindings, expandSharedSlotEdgeRemovals, resolveSlotInheritanceOwner,
} from "./sharedSlotBindings.js";
import { getStateSlotDisplayRows } from "./slotVisuals.js";

const data = (readPath = "", writePath = "", type = "EntitySlot") => ({
    inSlots: [{ key: "Entity", type, path: readPath, description: "read data" }],
    outSlots: [{ key: "Entity", type, path: writePath, description: "write data" }],
});

const slotEdge = (access, index = 0) => ({
    id: `e-${access}-${index}`,
    data: { edgeKind: "slot", skillNodeId: "skill", access, slotIndex: index },
});

test("one logical slot row retains both original handle identities", () => {
    const rows = getStateSlotDisplayRows(data(), "custom");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].handles.map((h) => h.handleId).sort(), ["slot-skill-read-0", "slot-skill-write-0"]);
    assert.equal(rows[0].access, "read-write");
    assert.equal(getGroupedSkillSlotRequests(data())[0].handles.length, 2);
});

test("matching names with different types and ambiguous duplicate keys remain independent", () => {
    const wrongType = { inSlots: [{ key: "X", type: "TypeA" }], outSlots: [{ key: "X", type: "TypeB" }] };
    assert.equal(getStateSlotDisplayRows(wrongType).length, 2);
    assert.equal(findSharedSlotPartner(wrongType, "read", 0), null);
    const ambiguous = { inSlots: [{ key: "X", type: "T" }, { key: "X", type: "T" }], outSlots: [{ key: "X", type: "T" }] };
    assert.equal(getStateSlotDisplayRows(ambiguous).length, 3);
    assert.equal(findSharedSlotPartner(ambiguous, "write", 0), null);
    assert.equal(getStateSlotDisplayRows(data(), "submachine").length, 2);
});

test("connecting either direction changes both bindings without mutating API requests", () => {
    const original = data();
    const readUpdated = updateSharedSlotBinding(original, "read", 0, { path: "/entity", inherited: null });
    assert.equal(readUpdated.inSlots[0].path, "/entity");
    assert.equal(readUpdated.outSlots[0].path, "/entity");
    assert.equal(original.inSlots[0].path, "");
    assert.equal(original.outSlots[0].path, "");
    assert.equal(readUpdated.inSlots[0].description, "read data");
    assert.equal(readUpdated.outSlots[0].description, "write data");
    const writeUpdated = updateSharedSlotBinding(readUpdated, "write", 0, { path: "/other" });
    assert.equal(writeUpdated.inSlots[0].path, "/other");
    assert.equal(writeUpdated.outSlots[0].path, "/other");
});

test("shared binding also synchronizes inherited xpath while keeping independent descriptors", () => {
    const original = data("/old", "/old");
    const inherited = updateSharedSlotBinding(original, "read", 0,
        { path: "/inherited", inherited: { state: "*", xpath: "/inherited" } });
    const updated = updateSharedSlotBinding(inherited, "write", 0, { path: "/new" });
    for (const request of [...updated.inSlots, ...updated.outSlots]) {
        assert.equal(request.path, "/new");
        assert.equal(request.inherited.xpath, "/new");
    }
    assert.notEqual(updated.inSlots[0].inherited, updated.outSlots[0].inherited);
});

test("existing contradictory saved paths are visible, not silently migrated", () => {
    const conflicting = data("/oldRead", "/oldWrite");
    assert.equal(getStateSlotDisplayRows(conflicting)[0].conflictingPaths, true);
    assert.equal(fillMissingSharedSlotBindings(conflicting), conflicting);
    const fixed = updateSharedSlotBinding(conflicting, "read", 0, { path: "/new", inherited: null });
    assert.equal(fixed.outSlots[0].path, "/new");
});

test("late API exposure fills missing counterpart but not a preexisting different binding", () => {
    const first = data("/entity", "");
    const next = fillMissingSharedSlotBindings(first);
    assert.equal(next.outSlots[0].path, "/entity");
    assert.equal(fillMissingSharedSlotBindings(data("/A", "/B")).outSlots[0].path, "/B");
});

test("deleting either visible edge deletes both only when they share a bound path", () => {
    const edges = [slotEdge("read"), slotEdge("write")];
    const changed = expandSharedSlotEdgeRemovals(
        [{ id: "skill", data: data("/entity", "/entity") }], edges,
        [{ id: "e-write-0", type: "remove" }]);
    assert.deepEqual(changed.map((change) => change.id).sort(), ["e-read-0", "e-write-0"]);
    const legacy = expandSharedSlotEdgeRemovals(
        [{ id: "skill", data: data("/a", "/b") }], edges,
        [{ id: "e-write-0", type: "remove" }]);
    assert.deepEqual(legacy.map((change) => change.id), ["e-write-0"]);
});


test("inheritance conflicts and inherited-only paths are not silently changed", () => {
    const old = data("/entity", "/entity");
    old.inSlots[0].inherited = { state: "A", xpath: "/entity" };
    old.outSlots[0].inherited = { state: "B", xpath: "/entity" };
    assert.equal(getStateSlotDisplayRows(old)[0].conflictingInheritance, true);
    const changes = expandSharedSlotEdgeRemovals(
        [{ id: "skill", data: old }], [slotEdge("read"), slotEdge("write")],
        [{ id: "e-read-0", type: "remove" }]);
    assert.equal(changes.length, 1);
    const inheritedOnly = data("/entity", "");
    inheritedOnly.outSlots[0].inherited = { state: "B", xpath: "/other" };
    assert.equal(fillMissingSharedSlotBindings(inheritedOnly), inheritedOnly);
});

test('right-click slot bindings export key and state, while obsolete malformed manual entries are omitted', async () => {
    const { buildRustSlotsSnapshot } = await import('./scxmlRustExport.js');
    const skill = { id: 'skill', type: 'custom', data: {
        fullSkillName: 'example.Writer#1', inSlots: [{ key: 'Entity', type: 'EntitySlot', path: '/entity' }],
        outSlots: [],
    }};
    const result = buildRustSlotsSnapshot({ nodes: [skill], manualSlots: [
        { id: 'manual-valid', key: 'Entity', state: 'example.Writer#1', path: '/entity' },
        { id: 'manual-old', path: '/entity' },
        { id: 'parsed-legacy', path: '/entity' },
    ] });
    assert.deepEqual(result.extraSlotDeclarations, [
        { key: 'Entity', state: 'example.Writer#1', xpath: '/entity', inherited: false },
        { key: '', state: '', xpath: '/entity', inherited: false },
    ]);
    assert.equal(result.states[0].inputSlots[0].key, 'Entity');
});


test("inheritance owner resolves a derived slot through a bound skill", () => {
    const nodes = [{ id: "writer", type: "custom", data: { fullSkillName: "Writer#1",
        outSlots: [{ key: "Result", type: "ObjectSlot", path: "/result" }] } }];
    assert.deepEqual(resolveSlotInheritanceOwner(nodes, "result"), { state: "Writer#1", key: "Result" });
});

test("inheritance owner resolves a child-only required slot through submachine", () => {
    const nodes = [{ id: "child", type: "submachine", data: { fullSkillName: "Search#2",
        inheritedSlots: [{ key: "Read", path: "/result", type: "ObjectSlot" }] } }];
    assert.deepEqual(resolveSlotInheritanceOwner(nodes, "result"), { state: "Search#2", key: "Read" });
});

test("inheritance does not invent a binding for an unbound slot", () => {
    assert.equal(resolveSlotInheritanceOwner([], "no-owner"), null);
});
