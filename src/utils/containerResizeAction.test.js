import assert from "node:assert/strict";
import test from "node:test";
import { getNodeSize, resizeStateContainerTree } from "./editorGeometry.js";
import { applyGraphTransaction } from "./graphTransaction.js";
import { toggleContainerCollapse } from "./containerState.js";
const find = (nodes, id) => nodes.find((node) => node.id === id);
const container = (id, type, parentId, position, width, height, data = {}) => ({
    id, type, parentId, position, width, height, style: { width, height }, data,
});

test("Resize shrinks a compound to fit nested compound while preserving content positions", () => {
    const nodes = [
        container("outer", "compound", undefined, { x: 10, y: 30 }, 1100, 900),
        container("inner", "compound", "outer", { x: 65, y: 100 }, 900, 650),
        { id: "leaf", type: "custom", parentId: "inner", position: { x: 60, y: 110 }, width: 145, height: 70 },
    ];
    const result = resizeStateContainerTree(nodes, "outer");
    assert.ok(getNodeSize(find(result, "inner")).width < 900);
    assert.ok(getNodeSize(find(result, "outer")).width < 1100);
    const inner = find(result, "inner");
    const outer = find(result, "outer");
    assert.ok(inner.position.x + getNodeSize(inner).width < getNodeSize(outer).width);
    assert.ok(inner.position.y + getNodeSize(inner).height < getNodeSize(outer).height);
    assert.deepEqual(find(result, "leaf").position, { x: 60, y: 110 });
    assert.deepEqual(nodes[2].position, { x: 60, y: 110 });
});

test("Resize nested parallel recalculates all lanes and its compound ancestor", () => {
    const nodes = [
        container("outer", "compound", undefined, { x: 0, y: 0 }, 1000, 1000),
        container("parallel", "parallel", "outer", { x: 55, y: 100 }, 850, 800),
        container("lane1", "parallelLane", "parallel", { x: 0, y: 64 }, 850, 380),
        container("lane2", "parallelLane", "parallel", { x: 0, y: 444 }, 850, 370),
        { id: "a", type: "custom", parentId: "lane1", position: { x: 55, y: 60 }, width: 130, height: 50 },
        { id: "b", type: "custom", parentId: "lane2", position: { x: 60, y: 50 }, width: 120, height: 60 },
    ];
    const result = resizeStateContainerTree(nodes, "parallel");
    const parallel = find(result, "parallel");
    const lane2 = find(result, "lane2");
    assert.ok(getNodeSize(parallel).width < 850);
    assert.ok(getNodeSize(parallel).height < 800);
    assert.ok(getNodeSize(find(result, "outer")).height < 1000);
    assert.equal(getNodeSize(lane2).width, getNodeSize(parallel).width);
    assert.deepEqual(find(result, "a").position, nodes[4].position);
    assert.deepEqual(find(result, "b").position, nodes[5].position);
});

test("Resize computes collapsed descendant expanded dimensions without opening it", () => {
    const nodes = [
        container("outer", "compound", undefined, { x: 0, y: 0 }, 950, 950),
        container("closed", "compound", "outer", { x: 80, y: 105 }, 210, 80,
            { isCollapsed: true, expandedContainerSize: { width: 900, height: 900 } }),
        { id: "leaf", type: "custom", parentId: "closed", position: { x: 55, y: 110 }, width: 150, height: 90 },
    ];
    const result = resizeStateContainerTree(nodes, "outer");
    const closed = find(result, "closed");
    assert.equal(closed.data.isCollapsed, true);
    assert.equal(getNodeSize(closed).width, 210);
    assert.equal(getNodeSize(closed).height, 80);
    assert.ok(closed.data.expandedContainerSize.width < 900);
    assert.ok(closed.data.expandedContainerSize.height < 900);
    assert.ok(getNodeSize(find(result, "outer")).width < 950);
    assert.deepEqual(find(result, "leaf").position, { x: 55, y: 110 });
});

test("Resize on a collapsed root updates saved dimensions without expanding it", () => {
    const nodes = [
        container("closed", "parallel", undefined, { x: 0, y: 0 }, 210, 80,
            { isCollapsed: true, expandedContainerSize: { width: 1100, height: 800 } }),
        container("lane", "parallelLane", "closed", { x: 0, y: 64 }, 900, 600),
        { id: "leaf", type: "custom", parentId: "lane", position: { x: 60, y: 55 }, width: 150, height: 60 },
    ];
    const result = resizeStateContainerTree(nodes, "closed");
    const closed = find(result, "closed");
    assert.ok(closed.data.expandedContainerSize.width < 1100);
    assert.ok(closed.data.expandedContainerSize.height < 800);
    assert.equal(closed.data.isCollapsed, true);
    assert.equal(getNodeSize(closed).width, 210);
});

test("one graph transaction changes nodes and edges together without stale updates", () => {
    const original = { nodes: ["a"], edges: ["a->b"], slotNodes: ["s"], label: "unchanged" };
    const next = applyGraphTransaction(original, (current) => ({
        nodes: [...current.nodes, "b"], edges: ["b->a"],
    }));
    assert.deepEqual(next, { nodes: ["a", "b"], edges: ["b->a"], slotNodes: ["s"], label: "unchanged" });
    assert.deepEqual(original, { nodes: ["a"], edges: ["a->b"], slotNodes: ["s"], label: "unchanged" });
    assert.equal(applyGraphTransaction(next, () => null), next);
    assert.equal(applyGraphTransaction(next, { edges: next.edges }), next);
    const later = applyGraphTransaction(next, (current) => ({ nodes: [...current.nodes, "c"] }));
    assert.deepEqual(later.nodes, ["a", "b", "c"]);
    assert.equal(later.edges, next.edges);
});


test("Resize of closed parallel round-trips through expansion without clipping its lane", () => {
    const nodes = [
        container("p", "parallel", undefined, { x: 0, y: 0 }, 210, 80,
            { isCollapsed: true, expandedContainerSize: { width: 1000, height: 1000 } }),
        container("lane", "parallelLane", "p", { x: 0, y: 64 }, 800, 500),
        { id: "skill", type: "custom", parentId: "lane", position: { x: 70, y: 60 }, width: 180, height: 70 },
    ];
    const compact = resizeStateContainerTree(nodes, "p");
    const opened = toggleContainerCollapse(compact, "p");
    const p = find(opened, "p");
    const lane = find(opened, "lane");
    const skill = find(opened, "skill");
    assert.equal(p.data.isCollapsed, false);
    assert.ok(getNodeSize(p).width < 1000);
    assert.ok(getNodeSize(lane).width >= skill.position.x + getNodeSize(skill).width);
    assert.ok(getNodeSize(lane).height >= skill.position.y + getNodeSize(skill).height);
    assert.ok(getNodeSize(p).height >= lane.position.y + getNodeSize(lane).height);
});
