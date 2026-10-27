import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getParallelSkillType,
  findParallelLaneSkillConflicts,
  collectParallelLaneSkillProblems,
} from './parallelLaneSkillValidation.js';

const parallel = (id) => ({ id, type:'parallel', data:{ label:id }});
const lane = (id,parentId) => ({ id, parentId, type:'parallelLane', data:{ label:id }});
const compound = (id,parentId) => ({ id, parentId, type:'compound', data:{} });
const skill = (id,parentId,fullSkillName, data={}) => ({ id, parentId, type:'custom', data:{ fullSkillName, ...data }});

test('distinct numbered instances are the same skill class across lanes', () => {
  const nodes = [parallel('p'), lane('a','p'),lane('b','p'),skill('one','a','Wait#1'),skill('two','b','Wait#2')];
  const conflicts = findParallelLaneSkillConflicts(nodes);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].skillType, 'Wait');
  assert.deepEqual(collectParallelLaneSkillProblems(nodes)[0].focusNodeIds,['one','two']);
});

test('same skill repeated within only one lane is allowed', () => {
  const nodes = [parallel('p'),lane('a','p'),lane('b','p'),skill('one','a','Wait#1'),skill('two','a','Wait#2'),skill('three','b','example.SlotWriter#1')];
  assert.deepEqual(findParallelLaneSkillConflicts(nodes),[]);
});

test('nested compounds do not hide lane conflicts', () => {
  const nodes=[parallel('p'),lane('a','p'),lane('b','p'),compound('c1','a'),compound('c2','b'),compound('nested','c2'),skill('one','c1','example.Wait#1'),skill('two','nested','example.Wait#2')];
  assert.equal(findParallelLaneSkillConflicts(nodes).length,1);
});

test('independent parallel regions with identical skill types are allowed', () => {
  const nodes=[parallel('p1'),lane('a','p1'),parallel('p2'),lane('b','p2'),skill('one','a','Wait#1'),skill('two','b','Wait#2')];
  assert.deepEqual(findParallelLaneSkillConflicts(nodes), []);
});

test('nested parallel checks its own lanes plus the enclosing lane', () => {
  const nodes=[parallel('outer'),lane('outer-a','outer'),lane('outer-b','outer'),parallel('inner'),
    lane('inner-a','inner'),lane('inner-b','inner'), skill('outer-skill','outer-b','Wait#1'),
    skill('inner-skill','inner-b','Wait#2')].map(n=>n.id==='inner'?{...n,parentId:'outer-a'}:n);
  const conflicts=findParallelLaneSkillConflicts(nodes);
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].parallelId,'outer');
});

test('focus limits rejection to the inserted/moved skill', () => {
  const nodes=[parallel('p'),lane('a','p'),lane('b','p'), skill('x','a','Wait#1'),skill('y','b','Wait#2'), skill('z','b','example.SlotWriter#1')];
  assert.equal(findParallelLaneSkillConflicts(nodes,{focusNodeIds:new Set(['z'])}).length,0);
  assert.equal(findParallelLaneSkillConflicts(nodes,{focusNodeIds:new Set(['y'])}).length,1);
});

test('editor references, End and Fatal are exempt', () => {
  const nodes=[parallel('p'),lane('a','p'),lane('b','p'),
    skill('one','a','End', {isFinal:true}),skill('two','b','End',{isFinal:true}),
    skill('ref','b','Wait#3',{isSkillClone:true,cloneOfNodeId:'origin'})];
  assert.equal(getParallelSkillType(nodes.at(-1)),'');
  assert.deepEqual(findParallelLaneSkillConflicts(nodes),[]);
});

test('different package types are not conflated', () => {
  const nodes=[parallel('p'),lane('a','p'),lane('b','p'),skill('one','a','a.Wait#1'),skill('two','b','b.Wait#2')];
  assert.deepEqual(findParallelLaneSkillConflicts(nodes),[]);
});
