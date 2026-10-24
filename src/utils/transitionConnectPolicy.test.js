import assert from 'node:assert/strict';
import test from 'node:test';
import { findExistingSharedParallelExit } from './transitionConnectPolicy.js';

const nodes = [
    { id: 'a', data: { fullSkillName: 'pkg.Wait#1' } },
    { id: 'b', data: { fullSkillName: 'pkg.Wait#2' } },
    { id: 'c', data: { fullSkillName: 'pkg.Other#1' } },
];
const first = { id: 'first', source: 'a', sourceHandle: 'success', target: 'out', data: {} };
const options = {
    edges: [first], nodes, targetId: 'out', parallelId: 'parallel', sourceHandle: 'success',
    logicalSourceIdOf: e => e.source,
    logicalSourceHandleOf: e => e.sourceHandle,
    exitedParallelIdsOf: () => ['parallel'],
};

test('a second drawn transition from the same skill must be created, not mistaken for an existing handler', () => {
    assert.equal(findExistingSharedParallelExit({ ...options, sourceId: 'a' }), null);
});

test('a matching event from another lane resolves to the existing shared parallel handler', () => {
    assert.equal(findExistingSharedParallelExit({ ...options, sourceId: 'b' })?.id, 'first');
});

test('unrelated skill events, targets, and scopes cannot alias a parallel handler', () => {
    assert.equal(findExistingSharedParallelExit({ ...options, sourceId: 'c' }), null);
    assert.equal(findExistingSharedParallelExit({ ...options, sourceId: 'b', targetId: 'other' }), null);
    assert.equal(findExistingSharedParallelExit({ ...options, sourceId: 'b', parallelId: 'another' }), null);
    assert.equal(findExistingSharedParallelExit({ ...options, sourceId: 'b',
        exitedParallelIdsOf: () => [] }), null);
});
