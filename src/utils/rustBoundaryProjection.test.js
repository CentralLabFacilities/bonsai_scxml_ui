import assert from 'node:assert/strict';
import test from 'node:test';
import { rebuildBoundaryTransitions } from './boundaryTransitions.js';
import { reconcileRustBoundaryPatch } from './rustBoundaryProjection.js';

const nodes = () => [
    { id: 'p', type: 'parallel', data: { events: [] } },
    { id: 'a', parentId: 'p', type: 'parallelLane', data: {} },
    { id: 'b', parentId: 'p', type: 'parallelLane', data: {} },
    { id: 'w1', parentId: 'a', type: 'custom', data: { fullSkillName: 'Wait#1', label: 'Wait', events: [{ id: 'success' }] } },
    { id: 'w2', parentId: 'b', type: 'custom', data: { fullSkillName: 'Wait#2', label: 'Wait', events: [{ id: 'success' }] } },
    { id: 'outside', type: 'custom', data: {} },
];
const edges = [{ id: 'exit', source: 'w1', target: 'outside', sourceHandle: 'success', data: {} }];

test('Rust transition deletion updates helper edges AND the lane handles in the same graph result', () => {
    const initial = rebuildBoundaryTransitions(nodes(), edges);
    assert.equal(initial.edges.length, 3);
    const after = reconcileRustBoundaryPatch(initial.nodes, initial.edges,
        { removedTransitionIds: ['exit'] }, { stateMode: 'none', applyTransitions: true });
    assert.deepEqual(after.edges, []);
    assert.deepEqual(after.nodes.find(n => n.id === 'a').data.events, []);
    assert.deepEqual(after.nodes.find(n => n.id === 'b').data.events, []);
});

test('Unrelated Rust patches retain all transition geometry and handles', () => {
    const initial = rebuildBoundaryTransitions(nodes(), edges);
    const after = reconcileRustBoundaryPatch(initial.nodes, initial.edges,
        { dataModel: [] }, { stateMode: 'none', applyTransitions: false });
    assert.strictEqual(after.nodes, initial.nodes);
    assert.strictEqual(after.edges, initial.edges);
});
