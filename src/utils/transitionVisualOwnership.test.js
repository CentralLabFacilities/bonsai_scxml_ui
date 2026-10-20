import assert from 'node:assert/strict';
import test from 'node:test';
import { rebuildBoundaryTransitions } from './boundaryTransitions.js';
import { projectParallelLaneExitEdges } from './parallelExitProjection.js';
import { resolveCanonicalTransitionEdge, canonicalizeVisibleEdgeChanges } from './transitionVisualOwnership.js';

const makeNodes = () => [
    { id: 'parallel', type: 'parallel', data: { events: [] } },
    { id: 'lane-1', parentId: 'parallel', type: 'parallelLane', data: {} },
    { id: 'lane-2', parentId: 'parallel', type: 'parallelLane', data: {} },
    { id: 'wait-1', parentId: 'lane-1', type: 'custom', data: { label: 'Wait', fullSkillName: 'Wait#1', events: [{ id: 'success' }] } },
    { id: 'wait-2', parentId: 'lane-2', type: 'custom', data: { label: 'Wait', fullSkillName: 'Wait#2', events: [{ id: 'success' }] } },
    { id: 'out', type: 'custom', data: {} },
    { id: 'other', type: 'custom', data: {} },
];
const transition = (id = 'semantic', target = 'out') => ({
    id, source: 'wait-1', target, sourceHandle: 'success', data: {},
});
const graph = () => rebuildBoundaryTransitions(makeNodes(), [transition()]);

test('each visible portion of a two-lane exit resolves to one canonical transition', () => {
    const state = graph();
    const canonical = state.edges.find(e => e.id === 'semantic');
    const helperLane1 = state.edges.find(e => e.data?.parallelInternalEdge && e.target === 'lane-1');
    const helperLane2 = state.edges.find(e => e.data?.parallelInternalEdge && e.target === 'lane-2');
    const visual = projectParallelLaneExitEdges(state.edges, new Map(state.nodes.map(n => [n.id, n])))[0];
    assert.equal(visual.source, 'lane-2');
    for (const part of [canonical, helperLane1, helperLane2, visual]) {
        assert.equal(resolveCanonicalTransitionEdge(part, state.edges, state.nodes)?.id, 'semantic');
        assert.equal(resolveCanonicalTransitionEdge(part.id, state.edges, state.nodes)?.id, 'semantic');
    }
    assert.equal(visual.selectable, true);
    assert.equal(visual.deletable, true);
});

test('deletion by any segment ID removes all shared exits and all lane ports', () => {
    const state = graph();
    const projected = projectParallelLaneExitEdges(state.edges, new Map(state.nodes.map(n => [n.id, n])))[0];
    const helper = state.edges.find(e => e.data?.parallelInternalEdge && e.target === 'lane-2');
    for (const visibleId of [projected.id, helper.id, 'semantic']) {
        const owner = resolveCanonicalTransitionEdge(visibleId, state.edges, state.nodes);
        const remaining = state.edges.filter(e => e.id !== owner.id);
        const cleaned = rebuildBoundaryTransitions(state.nodes, remaining);
        assert.deepEqual(cleaned.edges, [], `${visibleId} leaves no orphan edge`);
        for (const laneId of ['lane-1', 'lane-2']) {
            assert.deepEqual(cleaned.nodes.find(n => n.id === laneId).data.events, []);
        }
    }
});

test('shared helper with two possible targets does not delete both transitions by accident', () => {
    const state = rebuildBoundaryTransitions(makeNodes(), [transition('first', 'out'), transition('second', 'other')]);
    const helper = state.edges.find(e => e.data?.parallelInternalEdge && e.source === 'wait-2');
    assert.ok(helper);
    assert.equal(resolveCanonicalTransitionEdge(helper, state.edges), null);
    const projections = projectParallelLaneExitEdges(state.edges, new Map(state.nodes.map(n => [n.id, n])));
    assert.equal(projections.length, 2);
    assert.deepEqual(projections.map(e => resolveCanonicalTransitionEdge(e, state.edges)?.id).sort(), ['first', 'second']);
});

test('only actual lanes can be used to address a projection by ID', () => {
    const state = graph();
    assert.equal(resolveCanonicalTransitionEdge('projection-semantic-fake', state.edges, state.nodes), null);
    assert.equal(resolveCanonicalTransitionEdge('projection-semantic-lane-2', state.edges, []), null);
});

test('React Flow removes projected, helper and canonical pieces as ONE semantic change', () => {
    const state = graph();
    const projected = projectParallelLaneExitEdges(state.edges, new Map(state.nodes.map(n => [n.id, n])))[0];
    const helper = state.edges.find(e => e.data?.parallelInternalEdge && e.target === 'lane-2');
    assert.deepEqual(canonicalizeVisibleEdgeChanges([
        { id: helper.id, type: 'remove' },
        { id: projected.id, type: 'remove' },
    ], state.edges, state.nodes), [], 'automatic edge cleanup during node deletion must not delete the shared transition');
    const selectedEdges = state.edges.map(e => e.id === 'semantic' ? { ...e, selected: true } : e);
    assert.deepEqual(canonicalizeVisibleEdgeChanges([
        { id: helper.id, type: 'remove' },
        { id: projected.id, type: 'remove' },
        { id: 'semantic', type: 'remove' },
    ], selectedEdges, state.nodes), [{ id: 'semantic', type: 'remove' }]);
    assert.deepEqual(canonicalizeVisibleEdgeChanges([
        { id: helper.id, type: 'select', selected: true },
        { id: projected.id, type: 'select', selected: true },
    ], state.edges, state.nodes), []);
    assert.deepEqual(canonicalizeVisibleEdgeChanges([
        { id: 'slot1', type: 'remove' },
    ], state.edges, state.nodes, [{ id: 'slot1' }]), [{ id: 'slot1', type: 'remove' }]);
});
