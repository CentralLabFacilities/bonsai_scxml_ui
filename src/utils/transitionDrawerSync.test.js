import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileExternallyRemovedTransitions, hasTransitionScopeHierarchy } from './transitionDrawerSync.js';

test('canvas deletion removes only previously observed canonical edge, not new draft', () => {
  const a = {transitionId:'a',edgeId:'edge-a',target:'t'};
  const b = {transitionId:'b',edgeId:'edge-b',target:'u'};
  const pending = {transitionId:'new',edgeId:'edge-new',target:''};
  const observed = new Set(['edge-a','edge-b']);
  const result = reconcileExternallyRemovedTransitions([a,b,pending],[a,b],observed,['edge-b']);
  assert.deepEqual(result.draft,[b,pending]);
  assert.deepEqual(result.committed,[b]);
  assert.deepEqual([...result.removed],['edge-a']);
});
test('no graph change means drafts and saved transitions are preserved', () => {
  const t = {transitionId:'a',edgeId:'edge-a',conditionValue:'unsaved'};
  const saved = {...t,conditionValue:'saved'};
  const result = reconcileExternallyRemovedTransitions([t],[saved],new Set(['edge-a']),['edge-a']);
  assert.equal(result.draft[0],t);
  assert.equal(result.committed[0],saved);
  assert.equal(result.removed.size,0);
});
test('scope labels are unnecessary with only local transitions', () => {
  assert.equal(hasTransitionScopeHierarchy([{id:'root',depth:0}]),false);
  assert.equal(hasTransitionScopeHierarchy([{id:'root',depth:0},{id:'outer',depth:1}]),true);
  assert.equal(hasTransitionScopeHierarchy([{id:'outer',depth:2}]),true);
});
test('an unpublished transition must not disappear before its first graph update', () => {
  const pending = {transitionId:'pending',edgeId:'edge-pending',target:'new-target'};
  const result = reconcileExternallyRemovedTransitions([pending],[pending],new Set(),[]);
  assert.deepEqual(result.draft,[pending]);
  assert.equal(result.removed.size,0);
});

import { cleanEventsForDeletedTransitions } from './transitionDeletion.js';

const deletedTransitionMetadata = {
    getSourceId: (edge) => edge.source,
    getSourceHandle: (edge) => edge.sourceHandle,
};

test('deleting a conditioned transition clears persisted event metadata without deleting the exit token', () => {
    const nodes = [
        { id: 'wait', type: 'custom', data: { events: [
            { id: 'success', target: 'end', cond: 'counter == 1', assignments: [{ location: 'counter', expr: '2' }], selectedSkill: 'End' },
            { id: 'fatal', target: 'fatal', cond: '', assignments: [] },
        ] } },
        { id: 'parent', type: 'compound', data: { containerTransitionOrder: ['deleted', 'kept'] } },
    ];
    const removed = { id: 'deleted', source: 'wait', sourceHandle: 'success', target: 'end', data: { cond: 'counter == 1' } };
    const kept = { id: 'kept', source: 'wait', sourceHandle: 'fatal', target: 'fatal', data: { cond: '' } };
    const next = cleanEventsForDeletedTransitions(nodes, [removed], [kept], deletedTransitionMetadata);
    assert.equal(next[0].data.events.length, 2);
    assert.equal(next[0].data.events[0].target, null);
    assert.equal(next[0].data.events[0].cond, '');
    assert.deepEqual(next[0].data.events[0].assignments, []);
    assert.deepEqual(next[0].data.events[1], nodes[0].data.events[1]);
    assert.deepEqual(next[1].data.containerTransitionOrder, ['kept']);
});

test('deleting one of two conditional transitions preserves the other even for the same target', () => {
    const nodes = [{ id: 'wait', data: { events: [
        { id: 'success', target: 'end', cond: 'x == 1', assignments: [{ location: 'x', expr: '2' }] },
        { id: 'success', target: 'end', cond: 'x == 2', assignments: [{ location: 'x', expr: '3' }] },
    ] } }];
    const removed = { id: 'first', source: 'wait', sourceHandle: 'success', target: 'end', data: { cond: 'x == 1' } };
    const kept = { id: 'second', source: 'wait', sourceHandle: 'success', target: 'end', data: { cond: 'x == 2' } };
    const next = cleanEventsForDeletedTransitions(nodes, [removed], [kept], deletedTransitionMetadata);
    assert.equal(next[0].data.events[0].target, null);
    assert.equal(next[0].data.events[1].target, 'end');
    assert.deepEqual(next[0].data.events[1].assignments, nodes[0].data.events[1].assignments);
});

test('removing an imported synthetic transition removes its event and does not touch other events', () => {
    const nodes = [{ id: 'skill', data: { events: [
        { id: 'success', target: 'end', cond: '', editorImportedSynthetic: true },
        { id: 'fatal' },
    ] } }];
    const removed = { id: 'gone', source: 'skill', sourceHandle: 'success', target: 'end', data: {} };
    const next = cleanEventsForDeletedTransitions(nodes, [removed], [], deletedTransitionMetadata);
    assert.deepEqual(next[0].data.events, [{ id: 'fatal' }]);
});
