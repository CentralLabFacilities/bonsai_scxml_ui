import assert from 'node:assert/strict';
import test from 'node:test';
import { insertNodeWithParallelBoundarySync } from './libraryParallelInsertion.js';
import { measureParallelMinimumSize, getNodeSize, growAllStateContainersToContents } from './editorGeometry.js';
import { resizeParallelLanes } from './containerState.js';

const node = (id, type, parentId, data = {}, x = 0, y = 0, width = 180, height = 75) => ({
  id, type, parentId, data, position: {x, y}, width, height,
  style: {width, height},
});
const get = (nodes, id) => nodes.find((n) => n.id === id);

test('adding a matching Wait into another lane immediately rebuilds both shared boundary paths', () => {
  const nodes = [
    node('p','parallel', undefined, {},0,0,650,500),
    node('lane1','parallelLane','p',{},0,64,650,170),
    node('lane2','parallelLane','p',{},0,234,650,170),
    node('wait1','custom','lane1',{label:'Wait',fullSkillName:'Wait',events:[{id:'success',name:'success'}]},50,50,160,70),
    node('target','custom',undefined,{label:'End'},950,0),
  ];
  const edges = [{ id:'out', source:'wait1', sourceHandle:'success', target:'target', targetHandle:'transition-target', data: {}}];
  const before = insertNodeWithParallelBoundarySync(nodes, edges, (ns) => ns, 'wait1');
  const wait2 = node('wait2','custom','lane2',{label:'Wait',fullSkillName:'Wait',events:[{id:'success',name:'success'}]},50,50,160,70);
  const after = insertNodeWithParallelBoundarySync(before.nodes, before.edges, (ns) => [...ns, wait2], 'wait2');
  assert.ok(after.edges.some((e) => e.data?.parallelInternalEdge && e.source === 'wait2'),
    'new Wait must have its own lane helper immediately, without a drag');
  assert.ok(after.edges.some((e) => e.data?.parallelInternalEdge && e.source === 'wait1'));
  assert.equal(after.edges.filter((e) => e.data?.parallelExitId && !e.data?.parallelInternalEdge && !e.data?.boundaryInternalEdge).length, 1);
});

test('non-parallel insertion does not rebuild unrelated edge/node objects', () => {
  const nodes = [node('outer','compound',undefined), node('s','custom','outer')];
  const edges = [{ id: 'edge', source:'s', target:'outer'}];
  const result = insertNodeWithParallelBoundarySync(nodes,edges,(n)=>[...n,node('x','custom','outer')],'x');
  assert.equal(result.edges, undefined);
  assert.equal(result.nodes[0], nodes[0]);
});

test('parallel minimum ignores an oversized old lane wrapper and preserves positions on shrink', () => {
  const nodes = [node('p','parallel',undefined,{},0,0,1400,650),
    node('l1','parallelLane','p',{},0,64,1400,260),node('l2','parallelLane','p',{},0,324,1400,260),
    node('wrap','compound','l1',{autoParallelLaneCompound:true},0,0,1400,260),
    node('a','custom','wrap',{},50,58,160,70),node('b','custom','l2',{},52,62,160,70)];
  const min = measureParallelMinimumSize(nodes,'p');
  assert.ok(min.width < 700, `minimum inflated: ${min.width}`);
  const shrunk = resizeParallelLanes(nodes, 'p', min.width, min.height, min);
  const settled = growAllStateContainersToContents(shrunk);
  assert.equal(getNodeSize(get(settled,'p')).width, min.width,
    'grow-to-content must not reinflate the parallel');
  assert.deepEqual(get(settled,'a').position, {x:50,y:58});
});

test('manual parallel minimum includes a nested compound at its actual position', () => {
  const nodes = [node('p','parallel',undefined,{},0,0,1100,780),
    node('l','parallelLane','p',{},0,64,1100,680),
    node('nested','compound','l',{},72,46,490,320),
    node('leaf','custom','nested',{},45,90,170,80)];
  const min = measureParallelMinimumSize(nodes,'p');
  assert.ok(min.width >= 72+490+45, JSON.stringify(min));
  assert.ok(min.width < 1100);
});
