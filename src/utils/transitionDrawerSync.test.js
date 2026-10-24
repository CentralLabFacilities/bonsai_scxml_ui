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
