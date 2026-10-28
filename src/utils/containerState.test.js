import assert from "node:assert/strict";
import test from "node:test";
import { resizeParallelLanes, followParallelResizeGesture } from "./containerState.js";
import { workflowDtoToScxmlDocument } from "./scxmlRustDocument.js";
import { findDropContainerAtPoint, getNodeSize, measureParallelMinimumSize, growAllStateContainersToContents } from "./editorGeometry.js";

const byId = (nodes, id) => nodes.find((node) => node.id === id);

test("resizing a parallel keeps automatic wrappers aligned with their lanes", () => {
    const nodes = [
        { id: "p", type: "parallel", position: { x: 10, y: 20 } },
        { id: "a", type: "parallelLane", parentId: "p", position: { x: 0, y: 64 }, style: { width: 420, height: 130 } },
        { id: "b", type: "parallelLane", parentId: "p", position: { x: 0, y: 194 }, style: { width: 420, height: 130 } },
        { id: "wrapper", type: "compound", parentId: "a", position: { x: 0, y: 0 }, style: { width: 420, height: 130 }, data: { autoParallelLaneCompound: true } },
        { id: "skill", type: "custom", parentId: "wrapper", position: { x: 70, y: 80 }, width: 150, height: 50 },
    ];
    const changed = resizeParallelLanes(nodes, "p", 650, 550);
    const lane = byId(changed, "a");
    const wrapper = byId(changed, "wrapper");
    assert.equal(lane.style.width, 650);
    assert.equal(wrapper.style.width, lane.style.width);
    assert.equal(wrapper.style.height, lane.style.height);
    assert.deepEqual(wrapper.position, { x: 0, y: 0 });
    assert.deepEqual(byId(changed, "skill").position, { x: 70, y: 80 });
});

test("SCXML document gives region states an initial but never a parallel", () => {
    const doc = workflowDtoToScxmlDocument({
        initialScxmlStateId: "P",
        states: [
            { id: "p", scxmlId: "P", kind: "parallel", initialChildScxmlId: "RegionA" },
            { id: "a", scxmlId: "RegionA", kind: "parallelLane", parentId: "p", initialChildScxmlId: "A" },
            { id: "b", scxmlId: "A", kind: "skill", parentId: "a" },
        ],
    });
    const root = doc.getElementsByTagName("scxml")[0];
    assert.equal(root.getAttribute("initial"), "P");
    assert.equal(doc.getElementsByTagName("parallel")[0].getAttribute("initial"), null);
    assert.equal(doc.getElementsByTagName("state")[0].getAttribute("initial"), "A");
});

test("automatic wrappers cannot steal parallel lane drop hit-testing", () => {
    const nodes = [
        { id: "p", type: "parallel", position: { x: 100, y: 100 }, style: { width: 450, height: 400 } },
        { id: "lane", type: "parallelLane", parentId: "p", position: { x: 0, y: 64 }, style: { width: 450, height: 140 } },
        { id: "wrapper", type: "compound", parentId: "lane", position: { x: 0, y: 0 }, style: { width: 450, height: 140 }, data: { autoParallelLaneCompound: true } },
    ];
    assert.equal(findDropContainerAtPoint({ x: 140, y: 210 }, nodes)?.id, "lane");
});

import {
    getCollapsedBoundaryLayout,
    getContainerExitEvents,
    toggleContainerCollapse,
} from "./containerState.js";

test("parallel can shrink to the actual contents, not the old lane size", () => {
    const nodes = [
        { id: "p", type: "parallel", position: { x: 0, y: 0 }, width: 900, height: 900, style: { width: 900, height: 900 }, data: {} },
        { id: "lane", type: "parallelLane", parentId: "p", position: { x: 0, y: 64 }, width: 900, height: 791, style: { width: 900, height: 791 } },
        { id: "skill", type: "custom", parentId: "lane", position: { x: 50, y: 60 }, width: 160, height: 80 },
    ];
    const min = measureParallelMinimumSize(nodes, "p");
    assert.ok(min.width < 900 && min.height < 900, JSON.stringify(min));
    const smaller = resizeParallelLanes(nodes, "p", min.width, min.height);
    assert.equal(getNodeSize(byId(smaller, "p")).width, min.width);
    assert.equal(getNodeSize(byId(smaller, "p")).height, min.height);
    assert.equal(getNodeSize(byId(smaller, "lane")).height, min.laneHeights.get("lane"));
    assert.deepEqual(byId(smaller, "skill").position, { x: 50, y: 60 });
    const tooSmall = resizeParallelLanes(smaller, "p", 40, 40);
    assert.ok(getNodeSize(byId(tooSmall, "p")).width >= min.width);
    assert.ok(getNodeSize(byId(tooSmall, "p")).height >= min.height);
});

test("opening a nested container grows all ancestors without moving existing children", () => {
    const nodes = [
        { id: "outer", type: "compound", position: { x: 0, y: 0 }, width: 320, height: 200, data: {}, style: { width: 320, height: 200 } },
        { id: "parallel", type: "parallel", parentId: "outer", position: { x: 60, y: 90 }, width: 210, height: 80, style: { width: 210, height: 80 }, data: { isCollapsed: true, expandedContainerSize: { width: 420, height: 260 } } },
        { id: "lane", type: "parallelLane", parentId: "parallel", position: { x: 0, y: 64 }, width: 420, height: 150, style: { width: 420, height: 150 } },
        { id: "inner", type: "compound", parentId: "lane", position: { x: 80, y: 45 }, width: 350, height: 250, style: { width: 350, height: 250 }, data: {} },
        { id: "skill", type: "custom", parentId: "inner", position: { x: 110, y: 130 }, width: 200, height: 80 },
    ];
    const after = toggleContainerCollapse(nodes, "parallel");
    assert.equal(byId(after, "parallel").data.isCollapsed, false);
    assert.deepEqual(byId(after, "skill").position, { x: 110, y: 130 });
    assert.deepEqual(byId(after, "inner").position, { x: 80, y: 45 });
    assert.deepEqual(byId(after, "parallel").position, { x: 60, y: 90 });
    const inner = byId(after, "inner"), parallel = byId(after, "parallel"), lane = byId(after, "lane"), outer = byId(after, "outer");
    assert.ok(getNodeSize(inner).width >= 310 + 45 + 220);
    assert.ok(getNodeSize(lane).width >= 80 + getNodeSize(inner).width);
    assert.ok(getNodeSize(parallel).width >= getNodeSize(lane).width);
    assert.ok(getNodeSize(outer).width >= 60 + getNodeSize(parallel).width);
    assert.ok(getNodeSize(outer).height >= 90 + getNodeSize(parallel).height);
});

test("collapsed handles group by target and fit vertically", () => {
    const events = [
        { id: "a", target: "foo" }, { id: "b", target: "bar" },
        { id: "c", target: "foo" }, { id: "d", target: "bar" },
        { id: "e", target: "other" }, { id: "f", target: "other" },
    ];
    const layout = getCollapsedBoundaryLayout(events);
    assert.equal(layout.positions.get("c") - layout.positions.get("a"), 24);
    assert.equal(layout.positions.get("d") - layout.positions.get("b"), 24);
    assert.ok(layout.positions.get("b") > layout.positions.get("c"));
    assert.ok(layout.height > layout.positions.get("f") + 10);
    const collapsed = toggleContainerCollapse([
        { id: "c", type: "compound", position: { x: 0, y: 0 }, width: 600, height: 400, data: { events } },
    ], "c");
    assert.equal(getNodeSize(collapsed[0]).height, layout.height);
    assert.equal(getContainerExitEvents({ events }, "compound").length, 6);
});

test('compound resize minimum accounts for a nested parallel at its current position', async () => {
    const { measureCompoundMinimumSize } = await import('./editorGeometry.js');
    const nodes = [
        { id: 'outer', type: 'compound', data: { events: [] }, position: { x: 0, y: 0 }, style: { width: 900, height: 700 } },
        { id: 'nested', type: 'parallel', parentId: 'outer', position: { x: 65, y: 110 }, data: {}, style: { width: 950, height: 800 } },
        { id: 'lane', type: 'parallelLane', parentId: 'nested', position: { x: 0, y: 64 }, style: { width: 950, height: 700 } },
        { id: 'leaf', type: 'custom', parentId: 'lane', position: { x: 45, y: 45 }, width: 150, height: 60 },
    ];
    const minimum = measureCompoundMinimumSize(nodes, 'outer');
    const nestedMinimum = measureParallelMinimumSize(nodes, 'nested');
    assert.ok(minimum.width >= 65 + nestedMinimum.width + 45);
    assert.ok(minimum.height >= 110 + nestedMinimum.height + 45);
    assert.ok(minimum.width < 1250);
});

test('shrink two occupied parallel lanes even after previous large layout, including legacy wrapper', async () => {
    const { growAllStateContainersToContents } = await import('./editorGeometry.js');
    const nodes = [
        { id: 'p', type: 'parallel', width: 1200, height: 950, style: { width: 1200, height: 950 }, position: { x: 0, y: 0 } },
        { id: 'l1', type: 'parallelLane', parentId: 'p', width: 1200, height: 380, style: { width: 1200, height: 380 }, position: { x: 0, y: 64 }, expandParent: true },
        { id: 'l2', type: 'parallelLane', parentId: 'p', width: 1200, height: 380, style: { width: 1200, height: 380 }, position: { x: 0, y: 444 }, expandParent: true },
        { id: 'old', type: 'compound', parentId: 'l1', width: 1200, height: 380, style: { width: 1200, height: 380 }, position: { x: 0, y: 0 }, data: { autoParallelLaneCompound: true } },
        { id: 'w1', type: 'custom', parentId: 'old', width: 120, height: 65, position: { x: 40, y: 40 }, data: { label: 'Wait#1' } },
        { id: 'w2', type: 'custom', parentId: 'l2', width: 120, height: 65, position: { x: 40, y: 40 }, data: { label: 'Wait#2' } },
    ];
    const min = measureParallelMinimumSize(nodes, 'p');
    assert.ok(min.width < 1200, `width should depend on contents, got ${min.width}`);
    assert.ok(min.height < 950, `height should depend on contents, got ${min.height}`);
    const resized = resizeParallelLanes(nodes, 'p', min.width, min.height);
    const fitted = growAllStateContainersToContents(resized);
    assert.equal(getNodeSize(byId(fitted, 'p')).width, min.width);
    assert.equal(getNodeSize(byId(fitted, 'p')).height, min.height);
    assert.equal(byId(fitted, 'l1').expandParent, false);
    assert.equal(byId(fitted, 'l2').expandParent, false);
    assert.deepEqual(byId(fitted, 'w1').position, { x: 40, y: 40 });
    assert.deepEqual(byId(fitted, 'w2').position, { x: 40, y: 40 });
});

test('graph maintenance must not turn React Flow parent expansion back on for lane frames', async () => {
    const { normalizeContainerAutoExpansion } = await import('./editorGeometry.js');
    const nodes = [
        { id: 'p', type: 'parallel' },
        { id: 'lane', type: 'parallelLane', parentId: 'p', expandParent: true },
        { id: 'wrapper', type: 'compound', parentId: 'lane', expandParent: true, data: { autoParallelLaneCompound: true } },
        { id: 'Wait', type: 'custom', parentId: 'wrapper' },
    ];
    const normalized = normalizeContainerAutoExpansion(nodes);
    assert.equal(byId(normalized, 'lane').expandParent, false);
    assert.equal(byId(normalized, 'wrapper').expandParent, false);
    assert.equal(byId(normalized, 'Wait').expandParent, true);
    assert.equal(normalizeContainerAutoExpansion(normalized), normalized);
});

test('ordinary Wait lanes do not inherit a 170px invisible exit gutter', () => {
    const nodes = [
        { id: 'p', type: 'parallel', position: { x: 0, y: 0 }, width: 420, height: 460, style: { width: 420, height: 460 } },
        { id: 'a', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 64 }, width: 420, height: 170, style: { width: 420, height: 170 }, data: { events: [] } },
        { id: 'b', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 234 }, width: 420, height: 170, style: { width: 420, height: 170 }, data: { events: [] } },
        { id: 'wait1', type: 'custom', parentId: 'a', position: { x: 40, y: 45 }, width: 160, height: 70 },
        { id: 'wait2', type: 'custom', parentId: 'b', position: { x: 40, y: 45 }, width: 160, height: 70 },
    ];
    const min = measureParallelMinimumSize(nodes, 'p');
    assert.equal(min.width, 280, `an empty exit gutter should not block shrinking: ${min.width}`);
    const smaller = resizeParallelLanes(nodes, 'p', 310, 460, min);
    assert.equal(getNodeSize(byId(smaller, 'p')).width, 310);
    assert.equal(getNodeSize(byId(smaller, 'a')).width, 310);
    assert.equal(getNodeSize(byId(smaller, 'b')).width, 310);
    const settled = growAllStateContainersToContents(smaller);
    assert.equal(getNodeSize(byId(settled, 'p')).width, 310, 'grow-only pass must not undo shrink');
});

test('visible lane exits reserve measured label space, not a universal 170px floor', () => {
    const nodes = [
        { id: 'p', type: 'parallel', position: { x: 0, y: 0 }, width: 420, height: 400 },
        { id: 'lane', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 64 }, width: 420, height: 250,
            data: { events: [{ id: 'Wait.success', name: 'Wait.success', target: 'end' }] } },
        { id: 'wait', type: 'custom', parentId: 'lane', position: { x: 40, y: 45 }, width: 160, height: 70 },
    ];
    const minimum = measureParallelMinimumSize(nodes, 'p');
    assert.ok(minimum.width > 280 && minimum.width < 420, JSON.stringify(minimum));
    const shrunk = resizeParallelLanes(nodes, 'p', minimum.width + 12, 400);
    assert.equal(getNodeSize(byId(shrunk, 'p')).width, minimum.width + 12);
    const reverted = resizeParallelLanes(shrunk, 'p', 300, 400);
    assert.equal(getNodeSize(byId(reverted, 'p')).width, minimum.width,
        'release clamps to current content, even if gesture passed the real minimum');
    const withoutExit = nodes.map(n => n.id === 'lane' ? { ...n, data: { events: [] } } : n);
    assert.ok(measureParallelMinimumSize(withoutExit, 'p').width < minimum.width,
        'deleting the exit frees up its previous label gutter');
});

test('legacy lane wrapper does not make exit gutter count twice', () => {
    const nodes = [
        { id: 'p', type: 'parallel', position: { x: 0, y: 0 }, width: 900, height: 500 },
        { id: 'lane', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 64 }, width: 900, height: 300,
            data: { events: [{ id: 'Wait.success', target: 'end' }] } },
        { id: 'wrapper', type: 'compound', parentId: 'lane', position: { x: 0, y: 0 }, width: 900, height: 300,
            data: { autoParallelLaneCompound: true } },
        { id: 'wait', type: 'custom', parentId: 'wrapper', position: { x: 40, y: 45 }, width: 160, height: 70 },
    ];
    const min = measureParallelMinimumSize(nodes, 'p');
    assert.ok(min.width < 420, JSON.stringify(min));
    const shrunk = resizeParallelLanes(nodes, 'p', min.width, 400);
    const settled = growAllStateContainersToContents(shrunk);
    assert.equal(getNodeSize(byId(settled, 'p')).width, min.width);
    assert.equal(getNodeSize(byId(settled, 'wrapper')).width, min.width);
});


test("full-width lane extent is removed before React Flow can clamp shrink", async () => {
    const { normalizeContainerAutoExpansion } = await import("./editorGeometry.js");
    const nodes = [
        { id: "p", type: "parallel", width: 1079, height: 875, style: { width: 1079, height: 875 }, position: { x: 7.46, y: -32.05 } },
        { id: "l1", parentId: "p", type: "parallelLane", position: { x: 0, y: 64 }, width: 1079, height: 505.69, style: { width: 1079, height: 505.69 }, extent: "parent", expandParent: false },
        { id: "l2", parentId: "p", type: "parallelLane", position: { x: 0, y: 569.69 }, width: 1079, height: 260.31, style: { width: 1079, height: 260.31 }, extent: "parent", expandParent: true },
        { id: "a", parentId: "l1", type: "custom", position: { x: 230.79, y: 26.68 }, width: 260, height: 164, extent: "parent" },
        { id: "b", parentId: "l2", type: "custom", position: { x: 191.04, y: 56.31 }, width: 260, height: 164, extent: "parent" },
    ];
    const normalized = normalizeContainerAutoExpansion(nodes);
    for (const id of ["l1", "l2"]) {
        assert.equal(byId(normalized, id).extent, undefined, `${id} must not constrain parent width`);
        assert.equal(byId(normalized, id).expandParent, false);
    }
    assert.equal(byId(normalized, "a").extent, "parent", "skills retain drag containment");
    assert.equal(normalizeContainerAutoExpansion(normalized), normalized, "normalization is stable");

    const minimum = measureParallelMinimumSize(normalized, "p");
    assert.ok(minimum.width < 1079, `the contained skills need ${minimum.width}px, not 1079px`);
    const live = followParallelResizeGesture(normalized, "p", 720, 770);
    assert.equal(byId(live, "p").style.width, 720);
    assert.equal(byId(live, "l1").style.width, 720);
    assert.equal(byId(live, "l2").style.width, 720);
    assert.equal(byId(live, "l1").position.y, 64);
    assert.ok(Math.abs(byId(live, "l2").position.y + byId(live, "l2").height - (770 - 45)) < 0.0001);
    assert.equal(byId(live, "a"), byId(normalized, "a"), "existing skill position and identity are preserved");
    assert.equal(byId(live, "b"), byId(normalized, "b"));
    assert.equal(followParallelResizeGesture(live, "p", 720, 770), live, "same-size gesture does not publish again");

    const settled = resizeParallelLanes(live, "p", 720, 770);
    assert.equal(byId(settled, "p").style.width, 720);
    assert.equal(byId(settled, "l1").style.width, 720);
    assert.equal(byId(settled, "l2").style.width, 720);
});

test("during a resize, legacy automatic wrappers follow their lane, but genuine nested compounds do not", () => {
    const nodes = [
        { id: "p", type: "parallel", position: { x: 40, y: 50 }, style: { width: 950, height: 680 }, width: 950, height: 680 },
        { id: "a", type: "parallelLane", parentId: "p", position: { x: 0, y: 64 }, style: { width: 950, height: 270 }, width: 950, height: 270 },
        { id: "b", type: "parallelLane", parentId: "p", position: { x: 0, y: 334 }, style: { width: 950, height: 301 }, width: 950, height: 301 },
        { id: "legacy", type: "compound", parentId: "a", extent: "parent", expandParent: true, position: { x: 0, y: 0 }, style: { width: 950, height: 270 }, data: { autoParallelLaneCompound: true } },
        { id: "real", type: "compound", parentId: "b", position: { x: 40, y: 40 }, style: { width: 260, height: 180 } },
    ];
    const resized = followParallelResizeGesture(nodes, "p", 700, 510);
    assert.equal(byId(resized, "legacy").style.width, 700);
    assert.equal(byId(resized, "legacy").style.height, byId(resized, "a").style.height);
    assert.equal(byId(resized, "legacy").extent, undefined);
    assert.equal(byId(resized, "legacy").expandParent, false);
    assert.equal(byId(resized, "real"), byId(nodes, "real"));
    assert.deepEqual(byId(resized, "p").position, { x: 40, y: 50 }, "resizing lanes must not move the parallel");
});


test("resizing from a left corner preserves React Flow's new parallel position", () => {
    const nodes = [
        { id: "p", type: "parallel", position: { x: 175, y: 92 }, style: { width: 650, height: 500 }, width: 650, height: 500 },
        { id: "l1", type: "parallelLane", parentId: "p", position: { x: 0, y: 64 }, style: { width: 650, height: 194 }, width: 650, height: 194 },
        { id: "l2", type: "parallelLane", parentId: "p", position: { x: 0, y: 258 }, style: { width: 650, height: 197 }, width: 650, height: 197 },
        { id: "wait", type: "custom", parentId: "l1", position: { x: 20, y: 60 }, width: 120, height: 60 },
    ];
    const resized = followParallelResizeGesture(nodes, "p", 650, 500);
    assert.deepEqual(byId(resized, "p").position, { x: 175, y: 92 });
    assert.deepEqual(byId(resized, "wait").position, { x: 20, y: 60 });
    assert.equal(byId(resized, "l1").position.y, 64);
    assert.equal(byId(resized, "l2").position.y + byId(resized, "l2").height, 455);
});


test("parallel exits tolerate missing or malformed data while graph updates", () => {
    assert.deepEqual(getContainerExitEvents(undefined, "parallel"), []);
    assert.deepEqual(getContainerExitEvents({ events: { invalid: true } }, "parallel"), []);
    assert.deepEqual(getContainerExitEvents({ events: "success" }, "parallel"), []);
    assert.deepEqual(getContainerExitEvents({ events: [{ id: "success", target: "outside" }] }, "parallel").map(e => e.id), ["success"]);
});

// The lane React Flow hitbox must follow changing node measurements when the
// user switches Event/Overview/Slot modes (including legacy lane wrappers).
test('mode-switch measurement reflows lane borders and drop hitboxes without moving skills', async () => {
    const { reconcileMeasuredParallelLanes } = await import('./containerState.js');
    const nodes = [
        { id: 'p', type: 'parallel', position: { x: 10, y: 12 }, width: 460, height: 429,
            style: { width: 460, height: 429 } },
        { id: 'l1', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 64 }, width: 460, height: 160,
            style: { width: 460, height: 160 } },
        { id: 'l2', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 224 }, width: 460, height: 160,
            style: { width: 460, height: 160 } },
        { id: 'wait1', type: 'custom', parentId: 'l1', position: { x: 40, y: 40 },
            measured: { width: 180, height: 60 } },
        { id: 'wait2', type: 'custom', parentId: 'l2', position: { x: 40, y: 40 },
            measured: { width: 180, height: 60 } },
    ];
    const changed = nodes.map(n => n.id === 'wait1'
        ? { ...n, measured: { width: 180, height: 185 } } : n);
    const fitted = reconcileMeasuredParallelLanes(changed, ['wait1']);
    const first = byId(fitted, 'l1'), second = byId(fitted, 'l2'), parallel = byId(fitted, 'p');
    assert.ok(first.height >= 40 + 185 + 40, 'event/overview content must be inside the visible lane frame');
    assert.equal(second.position.y, first.position.y + first.height, 'lane dividers must be contiguous');
    assert.equal(second.position.y + second.height + 45, parallel.height, 'bottom lane and parallel share one boundary');
    assert.equal(first.width, parallel.width);
    assert.equal(second.width, parallel.width);
    assert.equal(byId(fitted, 'wait1'), changed[3], 'skill geometry is not rewritten');
    assert.equal(byId(fitted, 'wait2'), changed[4], 'other skill is not touched');
    assert.equal(reconcileMeasuredParallelLanes(fitted, ['wait1']), fitted, 'same measurements do not loop');
    const smaller = fitted.map(n => n.id === 'wait1' ? { ...n, measured: { width: 180, height: 60 } } : n);
    const back = reconcileMeasuredParallelLanes(smaller, ['wait1']);
    assert.equal(byId(back, 'l2').position.y, byId(back, 'l1').position.y + byId(back, 'l1').height);
});

test('mode-switch measurement also fits a legacy automatic lane compound', async () => {
    const { reconcileMeasuredParallelLanes } = await import('./containerState.js');
    const nodes = [
        { id: 'p', type: 'parallel', position: { x: 0, y: 0 }, width: 500, height: 429,
            style: { width: 500, height: 429 } },
        { id: 'l1', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 64 }, width: 500, height: 160,
            style: { width: 500, height: 160 } },
        { id: 'l2', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 224 }, width: 500, height: 160,
            style: { width: 500, height: 160 } },
        { id: 'wrapper', type: 'compound', parentId: 'l1', position: { x: 0, y: 0 }, width: 500, height: 160,
            style: { width: 500, height: 160 }, data: { autoParallelLaneCompound: true } },
        { id: 'wait', type: 'custom', parentId: 'wrapper', position: { x: 40, y: 45 },
            measured: { width: 175, height: 215 } },
    ];
    const updated = reconcileMeasuredParallelLanes(nodes, ['wait']);
    assert.ok(byId(updated, 'l1').height >= 45 + 215 + 40);
    assert.equal(byId(updated, 'wrapper').height, byId(updated, 'l1').height);
    assert.equal(byId(updated, 'wrapper').width, byId(updated, 'l1').width);
    assert.equal(byId(updated, 'l2').position.y, byId(updated, 'l1').position.y + byId(updated, 'l1').height);
    assert.equal(byId(updated, 'wait'), nodes[4]);
});

test('unrelated measurements and a collapsed parallel do not reflow lanes', async () => {
    const { reconcileMeasuredParallelLanes } = await import('./containerState.js');
    const nodes = [
        { id: 'p', type: 'parallel', data: { isCollapsed: true }, width: 210, height: 80 },
        { id: 'lane', parentId: 'p', type: 'parallelLane', position: { x: 0, y: 64 }, width: 500, height: 200 },
        { id: 'wait', parentId: 'lane', type: 'custom', measured: { width: 200, height: 210 }, position: { x: 40, y: 40 } },
    ];
    assert.equal(reconcileMeasuredParallelLanes(nodes, ['other']), nodes);
    assert.equal(reconcileMeasuredParallelLanes(nodes, ['wait']), nodes);
});

test('collapsed compound never claims drops in its old footprint or on the tiny collapsed header', () => {
    const expanded = [
        { id: 'container', type: 'compound', position: { x: 100, y: 100 },
          width: 540, height: 330, style: { width: 540, height: 330 }, data: {} },
        { id: 'nested', type: 'compound', parentId: 'container', position: { x: 270, y: 80 },
          width: 230, height: 200, data: {} },
    ];
    assert.equal(findDropContainerAtPoint({ x: 430, y: 240 }, expanded)?.id, 'nested');
    const collapsed = toggleContainerCollapse(expanded, 'container');
    assert.equal(byId(collapsed, 'container').data.isCollapsed, true);
    assert.equal(findDropContainerAtPoint({ x: 430, y: 240 }, collapsed), null);
    assert.equal(findDropContainerAtPoint({ x: 120, y: 125 }, collapsed), null);
    const restored = toggleContainerCollapse(collapsed, 'container');
    assert.equal(findDropContainerAtPoint({ x: 430, y: 240 }, restored)?.id, 'nested');
});

test('collapsed parallel hides lanes as drop targets, but the outer expanded compound can accept drops', () => {
    const nodes = [
        { id: 'outer', type: 'compound', position: { x: 0, y: 0 },
          width: 800, height: 480, data: {} },
        { id: 'parallel', type: 'parallel', parentId: 'outer', position: { x: 100, y: 90 },
          width: 210, height: 80, data: { isCollapsed: true, expandedContainerSize: { width: 620, height: 380 } } },
        { id: 'lane', type: 'parallelLane', parentId: 'parallel', position: { x: 0, y: 64 },
          width: 620, height: 240 },
        { id: 'wrapped', type: 'compound', parentId: 'lane', position: { x: 0, y: 0 },
          width: 620, height: 240, data: { autoParallelLaneCompound: true } },
        { id: 'nested', type: 'compound', parentId: 'wrapped', position: { x: 80, y: 60 },
          width: 200, height: 140, data: {} },
    ];
    assert.equal(findDropContainerAtPoint({ x: 220, y: 220 }, nodes)?.id, 'outer');
    assert.equal(findDropContainerAtPoint({ x: 150, y: 120 }, nodes)?.id, 'outer');
});
