import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPublishedGraphTransitions, getSharedContainerExitsForSkill } from './transitionDrawerLiveSync.js';
import { rebuildBoundaryTransitions } from './boundaryTransitions.js';

const skills = [
    { id: 'container', type: 'compound', data: { label: 'Container', events: [] }, position: { x: 0, y: 0 } },
    { id: 'wait1', type: 'custom', parentId: 'container', data: { fullSkillName: 'core.Wait#1', label: 'Wait', events: [{ id: 'success' }] }, position: { x: 30, y: 40 } },
    { id: 'wait2', type: 'custom', parentId: 'container', data: { fullSkillName: 'core.Wait#2', label: 'Wait', events: [{ id: 'success' }] }, position: { x: 40, y: 140 } },
    { id: 'other', type: 'custom', parentId: 'container', data: { fullSkillName: 'core.Other#1', label: 'Other', events: [{ id: 'success' }] }, position: { x: 40, y: 240 } },
    { id: 'outside', type: 'custom', data: { label: 'End' }, position: { x: 900, y: 20 } },
];

test('second Wait shows the shared compound exit without creating a duplicate semantic transition', () => {
    const graph = rebuildBoundaryTransitions(skills, [
        { id: 'exit', source: 'wait1', sourceHandle: 'success', target: 'outside', data: { cond: '' } },
    ]);
    assert.equal(graph.edges.filter(edge => !edge.data?.boundaryInternalEdge).length, 1);
    const shared = getSharedContainerExitsForSkill('wait2', graph.nodes, graph.edges);
    assert.deepEqual(shared.map(exit => ({ edge: exit.edgeId, event: exit.event, target: exit.target, scope: exit.scopeType })), [
        { edge: 'exit', event: 'success', target: 'outside', scope: 'compound' },
    ]);
    assert.deepEqual(getSharedContainerExitsForSkill('wait1', graph.nodes, graph.edges), []);
    assert.deepEqual(getSharedContainerExitsForSkill('other', graph.nodes, graph.edges), []);
});

test('shared exit disappears from second skill when the semantic edge is deleted', () => {
    const graph = rebuildBoundaryTransitions(skills, []);
    assert.deepEqual(getSharedContainerExitsForSkill('wait2', graph.nodes, graph.edges), []);
});

test('new edge appears in panel without losing incomplete drafts and existing edits', () => {
    const original = { edgeId: 'a', transitionId: 'a', conditionValue: 'unsaved edit' };
    const draft = { transitionId: 'draft', event: 'success', target: '' };
    const next = appendPublishedGraphTransitions([original, draft], [
        { edgeId: 'a', transitionId: 'a', conditionValue: 'server value' },
        { edgeId: 'b', transitionId: 'b', event: 'failure', target: 'outside' },
    ], new Set(['a']), new Set(['a', 'b']));
    assert.deepEqual(next.map(item => item.transitionId), ['a', 'draft', 'b']);
    assert.equal(next[0], original);
    assert.equal(next[1], draft);
});

test('published transition is not appended twice when already locally represented', () => {
    const local = { transitionId: 'b', edgeId: 'b', event: 'success' };
    const draft = [local];
    const output = appendPublishedGraphTransitions(draft, [
        { transitionId: 'b', edgeId: 'b', event: 'success' },
    ], new Set(), new Set(['b']));
    assert.equal(output, draft);
});
