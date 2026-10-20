import test from 'node:test';
import assert from 'node:assert/strict';
import { reorderParallelLaneIds } from './parallelLaneOrder.js';

test('drag lane insertion respects both sides of a target', () => {
    const lanes = ['first', 'second', 'third', 'fourth'];
    assert.deepEqual(reorderParallelLaneIds(lanes, 'first', { targetLaneId: 'third', placement: 'after' }), ['second', 'third', 'first', 'fourth']);
    assert.deepEqual(reorderParallelLaneIds(lanes, 'fourth', { targetLaneId: 'second', placement: 'before' }), ['first', 'fourth', 'second', 'third']);
    assert.deepEqual(lanes, ['first', 'second', 'third', 'fourth']);
});

test('reorder rejects unchanged and invalid targets without rebuilding graph', () => {
    const lanes = ['first', 'second', 'third'];
    assert.equal(reorderParallelLaneIds(lanes, 'first', { targetLaneId: 'second', placement: 'before' }), lanes);
    assert.equal(reorderParallelLaneIds(lanes, 'second', { targetLaneId: 'second', placement: 'after' }), lanes);
    assert.equal(reorderParallelLaneIds(lanes, 'missing', 'up'), lanes);
    assert.equal(reorderParallelLaneIds(lanes, 'first', 'up'), lanes);
    assert.equal(reorderParallelLaneIds(lanes, 'first', 'diagonal'), lanes);
    assert.deepEqual(reorderParallelLaneIds(lanes, 'second', 'down'), ['first', 'third', 'second']);
});
