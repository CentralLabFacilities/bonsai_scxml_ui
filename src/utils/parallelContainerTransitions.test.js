import assert from 'node:assert/strict';
import test from 'node:test';
import { applyParallelContainerTransitions } from './parallelContainerTransitions.js';
import { rebuildBoundaryTransitionsIncremental } from './boundaryTransitions.js';
import { isEditorInternalEvent, isValidScxmlEventDescriptor } from './transitionEventValidation.js';

const nodes = () => [
    {id:'p',type:'parallel',data:{events:[]}},
    {id:'l1',type:'parallelLane',parentId:'p',data:{}},
    {id:'l2',type:'parallelLane',parentId:'p',data:{}},
    {id:'w1',type:'custom',parentId:'l1',data:{label:'Wait',fullSkillName:'pkg.Wait#1',events:[{id:'success'}]}},
    {id:'w2',type:'custom',parentId:'l2',data:{label:'Wait',fullSkillName:'pkg.Wait#2',events:[{id:'success'}]}},
    {id:'target',type:'custom',data:{label:'End'}},
];
const edit = (args={}) => applyParallelContainerTransitions({nodes:nodes(),edges:[],parallelId:'p',transitions:[{event:'Wait.success.*',target:'target'}],...args});

test('qualified wildcard is one SCXML edge and sources both lanes',()=>{
    const result = edit();
    const semantic=result.edges.filter(e=>!e.data?.boundaryInternalEdge);
    assert.equal(semantic.length,1);
    assert.equal(semantic[0].data.boundaryImportedRawEvent,'Wait.success.*');
    assert.deepEqual(semantic[0].data.boundaryOriginalSources.map(s=>s.sourceId),['w1','w2']);
    assert.equal(result.edges.filter(e=>e.data?.parallelInternalEdge).length,2);
});
test('changing the descriptor replaces stale lane membership/ports',()=>{
    const initial=edit();
    const original=initial.edges.find(e=>!e.data?.boundaryInternalEdge);
    const updated=applyParallelContainerTransitions({nodes:initial.nodes,edges:initial.edges,
        parallelId:'p',managedEdgeIds:[original.id],transitions:[{edgeId:original.id,event:'Wait.error.*',target:'target'}]});
    const semantic=updated.edges.filter(e=>!e.data?.boundaryInternalEdge);
    assert.equal(semantic.length,1);
    assert.equal(semantic[0].data.boundaryImportedRawEvent,'Wait.error.*');
    assert.equal(semantic[0].data.boundaryOriginalSources[0].sourceHandle,'error.*');
});
test('unqualified success.* is direct on parallel, never renamed to Wait.success.*',()=>{
    const result=edit({transitions:[{event:'success.*',target:'target'}]});
    const semantic=result.edges.find(e=>!e.data?.boundaryInternalEdge);
    assert.equal(semantic.source,'p');
    assert.equal(semantic.sourceHandle,'success.*');
    assert.equal(semantic.data.boundaryImportedRawEvent,'success.*');
    assert.ok(result.nodes.find(n=>n.id==='p').data.events.some(e=>e.id==='success.*' && e.editorDirectParallelEvent));
});
test('deleting a managed transition removes the semantic edge and lane ports',()=>{
    const first=edit();
    const existing=first.edges.find(e=>!e.data?.boundaryInternalEdge);
    const result=applyParallelContainerTransitions({nodes:first.nodes,edges:first.edges,parallelId:'p',transitions:[],managedEdgeIds:[existing.id]});
    assert.deepEqual(result.edges,[]);
    assert.equal(result.nodes.find(n=>n.id==='l1').data.events.length,0);
    assert.equal(result.nodes.find(n=>n.id==='l2').data.events.length,0);
});
test('internal React Flow node identifiers are rejected as event descriptors',()=>{
    assert.equal(isEditorInternalEvent('skill-node-123e4567-e89b-12d3-a456-426614174000'),true);
    assert.equal(isValidScxmlEventDescriptor('skill-node-123e4567-e89b-12d3-a456-426614174000'),false);
    assert.equal(isValidScxmlEventDescriptor('Wait.skill-node-123e4567-e89b-12d3-a456-426614174000'),false);
    assert.equal(isValidScxmlEventDescriptor('Wait.success.*'),true);
    assert.equal(isValidScxmlEventDescriptor('success.*'),true);
    assert.equal(isValidScxmlEventDescriptor('error.cancelled'),true);
    assert.throws(()=>edit({transitions:[{event:'skill-node-abc',target:'target'}]}));
});

test('direct Parallel source port is removed on incremental edge deletion', () => {
    const first=edit({transitions:[{event:'success.*',target:'target'}]});
    const edge=first.edges[0];
    const updated=rebuildBoundaryTransitionsIncremental(first.nodes,[],{
        previousEdges:first.edges,changedEdgeIds:[edge.id],
    });
    assert.deepEqual(updated.nodes.find(n=>n.id==='p').data.events,[]);
});
