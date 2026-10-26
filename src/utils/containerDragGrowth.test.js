import assert from "node:assert/strict";
import test from "node:test";
import { createEditorNodeIndex } from "./editorGraph.js";
import {
    getNodeSize,
    growContainerForDraggedChild,
    shouldKeepDragInContainerNearBorder,
} from "./editorGeometry.js";

const rect = (id, type, parentId, x, y, width, height, data = {}) => ({
    id, type, parentId, position: { x, y }, width, height,
    style: { width, height }, data,
});
const find = (nodes, id) => nodes.find((node) => node.id === id);

test("a partly protruding child enlarges its existing compound without moving siblings", () => {
    const nodes = [
        rect("compound", "compound", undefined, 100, 50, 550, 320),
        rect("other", "custom", "compound", 60, 110, 120, 60),
        rect("moved", "custom", "compound", 390, 260, 190, 80),
    ];
    const grown = growContainerForDraggedChild(nodes, "moved");
    assert.ok(getNodeSize(find(grown, "compound")).width > 550);
    assert.ok(getNodeSize(find(grown, "compound")).height > 320);
    assert.deepEqual(find(grown, "moved").position, nodes[2].position);
    assert.deepEqual(find(grown, "other").position, nodes[1].position);
    assert.equal(find(grown, "moved").parentId, "compound");
});

test("growth propagates from a nested compound to its compound parent", () => {
    const nodes = [
        rect("outer", "compound", undefined, 0, 0, 700, 420),
        rect("inner", "compound", "outer", 280, 170, 350, 200),
        rect("moved", "custom", "inner", 290, 150, 130, 80),
    ];
    const grown = growContainerForDraggedChild(nodes, "moved");
    const inner = find(grown, "inner");
    assert.ok(getNodeSize(inner).width >= 420 + 45 + 220);
    assert.ok(getNodeSize(find(grown, "outer")).width >= inner.position.x + getNodeSize(inner).width);
    assert.deepEqual(find(grown, "moved").position, nodes[2].position);
});

test("moving past a compound's left and top expands it while preserving absolute skill positions", () => {
    const nodes = [
        rect("compound", "compound", undefined, 100, 150, 600, 410),
        rect("moved", "custom", "compound", -15, -12, 180, 80),
        rect("other", "custom", "compound", 210, 110, 120, 80),
    ];
    const before = createEditorNodeIndex(nodes);
    const grown = growContainerForDraggedChild(nodes, "moved");
    const after = createEditorNodeIndex(grown);
    assert.deepEqual(after.getAbsolutePosition(find(grown, "moved")), before.getAbsolutePosition(nodes[1]));
    assert.deepEqual(after.getAbsolutePosition(find(grown, "other")), before.getAbsolutePosition(nodes[2]));
    assert.deepEqual(find(grown, "compound").position, { x: 85, y: 138 });
    assert.ok(getNodeSize(find(grown, "compound")).width > 600);
});

test("a skill over a parallel lane border grows the lane and shifts subsequent lane frames", () => {
    const nodes = [
        rect("parallel", "parallel", undefined, 20, 10, 500, 380),
        rect("lane1", "parallelLane", "parallel", 0, 64, 500, 180),
        rect("lane2", "parallelLane", "parallel", 0, 244, 500, 130),
        rect("moved", "custom", "lane1", 400, 150, 140, 95),
        rect("other", "custom", "lane2", 55, 45, 140, 70),
    ];
    const grown = growContainerForDraggedChild(nodes, "moved");
    const lane1 = find(grown, "lane1");
    const lane2 = find(grown, "lane2");
    assert.ok(getNodeSize(lane1).height >= 245 + 40);
    assert.equal(lane2.position.y, lane1.position.y + getNodeSize(lane1).height);
    assert.ok(getNodeSize(find(grown, "parallel")).width >= 540 + 45);
    assert.equal(getNodeSize(lane1).width, getNodeSize(lane2).width);
    assert.deepEqual(find(grown, "moved").position, nodes[3].position);
    assert.deepEqual(find(grown, "other").position, nodes[4].position);
});

test("a generated compound wrapper uses its parallel lane, not compound exit padding", () => {
    const nodes = [
        rect("parallel", "parallel", undefined, 0, 0, 520, 400),
        rect("lane", "parallelLane", "parallel", 0, 64, 520, 260),
        rect("wrapper", "compound", "lane", 0, 0, 520, 260, { autoParallelLaneCompound: true }),
        rect("moved", "custom", "wrapper", 430, 190, 150, 110),
    ];
    const grown = growContainerForDraggedChild(nodes, "moved");
    assert.ok(getNodeSize(find(grown, "parallel")).width >= 580 + 45);
    assert.equal(getNodeSize(find(grown, "wrapper")).width, getNodeSize(find(grown, "lane")).width);
    assert.equal(getNodeSize(find(grown, "wrapper")).height, getNodeSize(find(grown, "lane")).height);
    assert.deepEqual(find(grown, "moved").position, nodes[3].position);
});

test("a marginal drop just outside stays in the old scope, but a deliberate move does not", () => {
    const nodes = [
        rect("compound", "compound", undefined, 100, 100, 500, 300),
        rect("moved", "custom", "compound", 385, 100, 150, 100),
    ];
    const index = createEditorNodeIndex(nodes);
    const [container, skill] = nodes;
    assert.equal(shouldKeepDragInContainerNearBorder(skill, container, { x: 615, y: 250 }, nodes, index), true);
    assert.equal(shouldKeepDragInContainerNearBorder(skill, container, { x: 680, y: 250 }, nodes, index), false);
    assert.equal(shouldKeepDragInContainerNearBorder(skill, container, { x: 540, y: 250 }, nodes, index), false);
    assert.equal(shouldKeepDragInContainerNearBorder(skill, container, { x: 615, y: 600 }, nodes, index), false);
});


test("ordinary movement fully inside a container does not change geometry or its node array", () => {
    const nodes = [
        rect("compound", "compound", undefined, 5, 5, 650, 400),
        rect("skill", "custom", "compound", 80, 90, 160, 80),
    ];
    assert.strictEqual(growContainerForDraggedChild(nodes, "skill"), nodes);
});
