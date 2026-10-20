import assert from 'node:assert/strict';
import test from 'node:test';
import { projectParallelLaneExitEdges } from './parallelExitProjection.js';
import { rebuildBoundaryTransitions } from './boundaryTransitions.js';

const makeNodes = () => [
    { id:'p', type:'parallel', data:{events:[]} },
    { id:'lane-a', type:'parallelLane', parentId:'p', data:{} },
    { id:'lane-b', type:'parallelLane', parentId:'p', data:{} },
    { id:'wait-a', type:'custom', parentId:'lane-a', data:{label:'Wait',fullSkillName:'pkg.Wait#1',events:[{id:'success'}]} },
    { id:'wait-b', type:'custom', parentId:'lane-b', data:{label:'Wait',fullSkillName:'pkg.Wait#2',events:[{id:'success'}]} },
    { id:'out', type:'custom', data:{label:'Output'} },
];
const makeEdges = () => [{id:'semantic',source:'wait-a',target:'out',sourceHandle:'success',data:{}}];
const project = (graph) => projectParallelLaneExitEdges(graph.edges, new Map(graph.nodes.map(n=>[n.id,n])));

test('a single SCXML transition has rendered exit-to-target legs in both parallel lanes', () => {
    const graph = rebuildBoundaryTransitions(makeNodes(), makeEdges());
    const helper = graph.edges.filter(e=>e.data?.parallelInternalEdge);
    assert.deepEqual(helper.map(e=>e.target).sort(),['lane-a','lane-b']);
    assert.equal(graph.edges.filter(e=>!e.data?.boundaryInternalEdge).length,1);
    const copies=project(graph);
    assert.equal(copies.length,1);
    assert.equal(copies[0].source,'lane-b');
    assert.equal(copies[0].target,'out');
    assert.equal(copies[0].sourceHandle,graph.edges.find(e=>e.id==='semantic').sourceHandle);
    assert.equal(copies[0].data.projectionOfEdgeId,'semantic');
    assert.equal(copies[0].selectable,true);
    assert.equal(copies[0].deletable,true);
    assert.equal(project(graph)[0].id,copies[0].id,'stable visual identity');
});

test('projected exit disappears with the semantic edge or collapsed parallel', () => {
    const graph = rebuildBoundaryTransitions(makeNodes(), makeEdges());
    const owner = graph.nodes.find(n=>n.id==='p');
    const collapsed = graph.nodes.map(n=> n===owner ? {...n,data:{...n.data,isCollapsed:true}} : n);
    assert.deepEqual(projectParallelLaneExitEdges(graph.edges,new Map(collapsed.map(n=>[n.id,n]))),[]);
    assert.deepEqual(project(rebuildBoundaryTransitions(graph.nodes,[])),[]);
});

test('a closer handler in a lane suppresses that lane projection', () => {
    const nodes = makeNodes();
    nodes.find(n=>n.id==='wait-b').data.events=[{id:'success',target:'out'}];
    // Direct local handler to a target inside the parallel shadows only that lane.
    nodes.push({id:'inner',type:'custom',parentId:'lane-b',data:{}});
    nodes.find(n=>n.id==='wait-b').data.events=[{id:'success',target:'inner'}];
    const graph=rebuildBoundaryTransitions(nodes,makeEdges());
    assert.deepEqual(graph.edges.filter(e=>e.data?.parallelInternalEdge).map(e=>e.target),['lane-a']);
    assert.deepEqual(project(graph),[]);
});
