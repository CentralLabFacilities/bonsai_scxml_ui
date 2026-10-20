import assert from "node:assert/strict";
import test from "node:test";
import { applyRustWorkflowStatePatch } from "./rustWorkflowPatch.js";
import { workflowDtoToScxmlDocument } from "./scxmlRustDocument.js";

const lane = { id: "region", type: "parallelLane", parentId: "parallel", data: { label: "Lane_1", initialChildId: "wrapper" } };
const skill = (id, parentId, x, y) => ({ id, type: "custom", parentId, position: { x, y }, data: {} });

const patchForLane = (memberStateIds, overrides = {}) => ({
    removedStateIds: [],
    states: [],
    parallelLaneUpdates: [{
        laneId: "region",
        memberStateIds,
        initialChildId: memberStateIds[0] || null,
        wrapperStateId: null,
        ...overrides,
    }],
});

test("a region with multiple children does not gain a redundant compound", () => {
    const nodes = [lane, skill("a", "region", 20, 35), skill("b", "region", 240, 35)];
    const result = applyRustWorkflowStatePatch(nodes, patchForLane(["a", "b"]), { mode: "move" });
    assert.equal(result.length, 3);
    assert.equal(result.find((n) => n.id === "region").data.initialChildId, "a");
    assert.equal(result.find((n) => n.id === "a").data.isInitial, true);
    assert.equal(result.find((n) => n.id === "b").parentId, "region");
    assert.deepEqual(result.find((n) => n.id === "b").position, { x: 240, y: 35 });
});

test("legacy automatic wrapper removal preserves relative positions and explicit initial state", () => {
    const wrapper = {
        id: "wrapper", type: "compound", parentId: "region", position: { x: 15, y: 10 },
        data: { autoParallelLaneCompound: true, initialChildId: "b" },
    };
    const nodes = [lane, wrapper, skill("a", "wrapper", 20, 35), skill("b", "wrapper", 240, 35)];
    const result = applyRustWorkflowStatePatch(
        nodes,
        { ...patchForLane(["a", "b"], { initialChildId: "b" }), removedStateIds: ["wrapper"] },
        { mode: "move" },
    );
    assert.equal(result.find((n) => n.id === "wrapper"), undefined);
    assert.equal(result.find((n) => n.id === "a").parentId, "region");
    assert.deepEqual(result.find((n) => n.id === "a").position, { x: 35, y: 45 });
    assert.deepEqual(result.find((n) => n.id === "b").position, { x: 255, y: 45 });
    assert.equal(result.find((n) => n.id === "b").data.isInitial, true);
    assert.equal(result.find((n) => n.id === "region").data.initialChildId, "b");
});

test("intentional nested compounds are never unwrapped", () => {
    const nested = { id: "user-compound", type: "compound", parentId: "region", position: { x: 25, y: 30 }, data: { label: "My compound" } };
    const result = applyRustWorkflowStatePatch(
        [lane, nested, skill("a", "user-compound", 20, 35)],
        patchForLane(["user-compound"]), { mode: "move" },
    );
    assert.ok(result.some((n) => n.id === "user-compound"));
    assert.equal(result.find((n) => n.id === "a").parentId, "user-compound");
});

test("Rust canonical coordinates are not shifted twice during wrapper removal", () => {
    const wrapper = {
        id: "wrapper", type: "compound", parentId: "region", position: { x: 15, y: 10 },
        data: { autoParallelLaneCompound: true },
    };
    const patch = {
        ...patchForLane(["a"], { initialChildId: "a" }),
        removedStateIds: ["wrapper"],
        states: [{
            id: "a",
            editor: { x: 35, y: 45, positions: [] },
            isInitial: true,
            isFinal: false,
        }],
    };
    const result = applyRustWorkflowStatePatch(
        [lane, wrapper, skill("a", "wrapper", 20, 35)],
        patch,
        { mode: "move" },
    );
    assert.deepEqual(result.find((n) => n.id === "a").position, { x: 35, y: 45 });
});


test("two nodes in the same region export to one Lane_1 state without lane_1", () => {
    const doc = workflowDtoToScxmlDocument({
        initialScxmlStateId: "parallel_1",
        states: [
            { id: "p", scxmlId: "parallel_1", kind: "parallel" },
            { id: "lane", parentId: "p", scxmlId: "Lane_1", kind: "parallelLane", initialChildScxmlId: "Wait#1" },
            { id: "a", parentId: "lane", scxmlId: "Wait#1", kind: "skill" },
            { id: "b", parentId: "lane", scxmlId: "Wait#2", kind: "skill" },
        ],
    });
    const parallel = doc.getElementsByTagName("parallel")[0];
    const region = parallel.children.find((c) => c.getAttribute("id") === "Lane_1");
    assert.equal(region.getAttribute("initial"), "Wait#1");
    assert.equal(region.children.filter((c) => c.localName === "state").length, 2);
    assert.equal(doc.getElementsByTagName("state").some((c) => c.getAttribute("id") === "lane_1"), false);
});
